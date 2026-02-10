use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

pub const HOT_REFRESH_BACKEND_EVENT: &str = "opcode://hot-refresh-file-changed";
const DEBOUNCE_MS: u64 = 650;

#[derive(Default)]
pub struct HotRefreshWatcherState {
    inner: Mutex<Option<HotRefreshWatcherController>>,
}

struct HotRefreshWatcherController {
    watcher: Option<RecommendedWatcher>,
    worker_thread: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotRefreshPayload {
    paths: Vec<String>,
    timestamp_ms: u128,
}

impl HotRefreshWatcherController {
    fn start(app: AppHandle, paths: Vec<PathBuf>) -> Result<Self, String> {
        let running = Arc::new(AtomicBool::new(true));
        let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();

        let watcher_tx = event_tx.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = watcher_tx.send(event);
        })
        .map_err(|error| format!("Failed to create hot-refresh watcher: {}", error))?;

        let mut watched_any = false;
        for path in paths {
            if !path.exists() {
                continue;
            }

            let mode = if path.is_dir() {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };

            watcher
                .watch(&path, mode)
                .map_err(|error| format!("Failed to watch path {}: {}", path.display(), error))?;
            watched_any = true;
        }

        if !watched_any {
            return Err("No valid watch paths were available for hot refresh.".to_string());
        }

        let worker_running = running.clone();
        let worker_app = app.clone();
        let worker_thread = thread::spawn(move || {
            run_watcher_worker(worker_app, event_rx, worker_running);
        });

        Ok(Self {
            watcher: Some(watcher),
            worker_thread: Some(worker_thread),
            running,
        })
    }

    fn stop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        let _ = self.watcher.take();

        if let Some(thread) = self.worker_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for HotRefreshWatcherController {
    fn drop(&mut self) {
        self.stop();
    }
}

fn normalize_watch_paths(raw_paths: Vec<String>) -> Vec<PathBuf> {
    let mut deduped = HashSet::new();
    raw_paths
        .into_iter()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .filter(|entry| deduped.insert(entry.clone()))
        .map(PathBuf::from)
        .collect()
}

fn is_supported_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("ts")
            | Some("tsx")
            | Some("js")
            | Some("jsx")
            | Some("css")
            | Some("html")
            | Some("json")
            | Some("rs")
    )
}

fn is_relevant_event_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Modify(_)
            | EventKind::Remove(_)
            | EventKind::Any
            | EventKind::Other
    )
}

fn event_paths_for_refresh(event: &Event) -> Vec<String> {
    if !is_relevant_event_kind(&event.kind) {
        return Vec::new();
    }

    event
        .paths
        .iter()
        .filter(|path| is_supported_extension(path))
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn now_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn flush_pending_event(app: &AppHandle, pending_paths: &mut HashSet<String>) {
    if pending_paths.is_empty() {
        return;
    }

    let payload = HotRefreshPayload {
        paths: pending_paths.drain().collect(),
        timestamp_ms: now_timestamp_ms(),
    };

    if let Err(error) = app.emit(HOT_REFRESH_BACKEND_EVENT, payload) {
        tracing::warn!("Failed to emit hot-refresh event: {}", error);
    }
}

fn run_watcher_worker(
    app: AppHandle,
    event_rx: mpsc::Receiver<notify::Result<Event>>,
    running: Arc<AtomicBool>,
) {
    let debounce_window = Duration::from_millis(DEBOUNCE_MS);
    let mut pending_paths: HashSet<String> = HashSet::new();
    let mut last_relevant_change: Option<Instant> = None;

    while running.load(Ordering::Relaxed) {
        match event_rx.recv_timeout(Duration::from_millis(150)) {
            Ok(Ok(event)) => {
                let event_paths = event_paths_for_refresh(&event);
                if !event_paths.is_empty() {
                    for path in event_paths {
                        pending_paths.insert(path);
                    }
                    last_relevant_change = Some(Instant::now());
                }
            }
            Ok(Err(error)) => {
                tracing::warn!("Hot-refresh watcher error: {}", error);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if let Some(last_change) = last_relevant_change {
            if last_change.elapsed() >= debounce_window {
                flush_pending_event(&app, &mut pending_paths);
                last_relevant_change = None;
            }
        }
    }

    flush_pending_event(&app, &mut pending_paths);
}

fn restart_watcher(
    app: AppHandle,
    state: &State<'_, HotRefreshWatcherState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let normalized_paths = normalize_watch_paths(paths);
    if normalized_paths.is_empty() {
        return Err("No hot-refresh watch paths were provided.".to_string());
    }

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock hot-refresh watcher state.".to_string())?;

    if let Some(mut existing) = guard.take() {
        existing.stop();
    }

    let watcher = HotRefreshWatcherController::start(app, normalized_paths)?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn hot_refresh_start(
    app: AppHandle,
    state: State<'_, HotRefreshWatcherState>,
    paths: Vec<String>,
) -> Result<(), String> {
    restart_watcher(app, &state, paths)
}

#[tauri::command]
pub fn hot_refresh_stop(state: State<'_, HotRefreshWatcherState>) -> Result<(), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock hot-refresh watcher state.".to_string())?;

    if let Some(mut controller) = guard.take() {
        controller.stop();
    }

    Ok(())
}

#[tauri::command]
pub fn hot_refresh_update_paths(
    app: AppHandle,
    state: State<'_, HotRefreshWatcherState>,
    paths: Vec<String>,
) -> Result<(), String> {
    restart_watcher(app, &state, paths)
}

#[cfg(test)]
mod tests {
    use super::{event_paths_for_refresh, is_supported_extension, normalize_watch_paths};
    use notify::{Event, EventKind, ModifyKind};
    use std::path::PathBuf;

    #[test]
    fn normalize_watch_paths_trims_and_dedupes() {
        let paths = normalize_watch_paths(vec![
            " src ".to_string(),
            "src".to_string(),
            "src-tauri/src".to_string(),
            "".to_string(),
        ]);

        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&PathBuf::from("src")));
        assert!(paths.contains(&PathBuf::from("src-tauri/src")));
    }

    #[test]
    fn supported_extension_filter_matches_plan_contract() {
        assert!(is_supported_extension(PathBuf::from("file.ts").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.tsx").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.js").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.jsx").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.css").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.html").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.json").as_path()));
        assert!(is_supported_extension(PathBuf::from("file.rs").as_path()));
        assert!(!is_supported_extension(PathBuf::from("file.md").as_path()));
        assert!(!is_supported_extension(PathBuf::from("folder").as_path()));
    }

    #[test]
    fn event_filter_ignores_irrelevant_or_unsupported_changes() {
        let relevant = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            paths: vec![PathBuf::from("src/App.tsx")],
            attrs: notify::event::EventAttributes::new(),
        };

        let ignored_extension = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            paths: vec![PathBuf::from("README.md")],
            attrs: notify::event::EventAttributes::new(),
        };

        let ignored_kind = Event {
            kind: EventKind::Access(notify::event::AccessKind::Read),
            paths: vec![PathBuf::from("src/App.tsx")],
            attrs: notify::event::EventAttributes::new(),
        };

        assert_eq!(event_paths_for_refresh(&relevant), vec!["src/App.tsx".to_string()]);
        assert!(event_paths_for_refresh(&ignored_extension).is_empty());
        assert!(event_paths_for_refresh(&ignored_kind).is_empty());
    }
}
