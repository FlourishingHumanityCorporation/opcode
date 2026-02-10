use chrono::Local;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub mod query;
pub mod schema;
pub mod sync;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageEntry {
    pub timestamp: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost: f64,
    pub session_id: String,
    pub project_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageStats {
    pub total_cost: f64,
    pub total_tokens: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_sessions: u64,
    pub by_model: Vec<ModelUsage>,
    pub by_date: Vec<DailyUsage>,
    pub by_project: Vec<ProjectUsage>,
}

impl Default for UsageStats {
    fn default() -> Self {
        Self {
            total_cost: 0.0,
            total_tokens: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_creation_tokens: 0,
            total_cache_read_tokens: 0,
            total_sessions: 0,
            by_model: Vec::new(),
            by_date: Vec::new(),
            by_project: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelUsage {
    pub model: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub session_count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailyUsage {
    pub date: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub models_used: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectUsage {
    pub project_path: String,
    pub project_name: String,
    pub total_cost: f64,
    pub total_tokens: u64,
    pub session_count: u64,
    pub last_used: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageIndexStatus {
    pub state: String,
    pub started_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_error: Option<String>,
    pub files_total: u64,
    pub files_processed: u64,
    pub lines_processed: u64,
    pub entries_indexed: u64,
    pub current_file: Option<String>,
    pub cancelled: bool,
}

impl Default for UsageIndexStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            started_at: None,
            last_completed_at: None,
            last_error: None,
            files_total: 0,
            files_processed: 0,
            lines_processed: 0,
            entries_indexed: 0,
            current_file: None,
            cancelled: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SyncOutcome {
    pub files_total: u64,
    pub files_processed: u64,
    pub lines_processed: u64,
    pub entries_indexed: u64,
    pub entries_ignored: u64,
    pub parse_errors: u64,
    pub cancelled: bool,
}

#[derive(Default)]
struct UsageIndexStateInner {
    is_running: AtomicBool,
    cancel_requested: AtomicBool,
    status: Mutex<UsageIndexStatus>,
}

#[derive(Clone, Default)]
pub struct UsageIndexState {
    inner: Arc<UsageIndexStateInner>,
}

impl UsageIndexState {
    pub fn try_start(&self) -> bool {
        self.inner
            .is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn finish(&self) {
        self.inner.is_running.store(false, Ordering::SeqCst);
    }

    pub fn request_cancel(&self) {
        self.inner.cancel_requested.store(true, Ordering::SeqCst);
    }

    pub fn clear_cancel(&self) {
        self.inner.cancel_requested.store(false, Ordering::SeqCst);
    }

    pub fn is_cancel_requested(&self) -> bool {
        self.inner.cancel_requested.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> UsageIndexStatus {
        self.inner
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| UsageIndexStatus::default())
    }

    pub fn update_status<F>(&self, update: F)
    where
        F: FnOnce(&mut UsageIndexStatus),
    {
        if let Ok(mut status) = self.inner.status.lock() {
            update(&mut status);
        }
    }

    pub fn mark_started(&self, files_total: u64) {
        self.clear_cancel();
        let started_at = Local::now().to_rfc3339();
        self.update_status(|status| {
            let last_completed = status.last_completed_at.clone();
            *status = UsageIndexStatus {
                state: "indexing".to_string(),
                started_at: Some(started_at),
                last_completed_at: last_completed,
                last_error: None,
                files_total,
                files_processed: 0,
                lines_processed: 0,
                entries_indexed: 0,
                current_file: None,
                cancelled: false,
            };
        });
    }

    pub fn mark_completed(&self, outcome: &SyncOutcome) {
        let completed_at = Local::now().to_rfc3339();
        self.update_status(|status| {
            status.state = "idle".to_string();
            status.last_completed_at = Some(completed_at);
            status.last_error = None;
            status.files_total = outcome.files_total;
            status.files_processed = outcome.files_processed;
            status.lines_processed = outcome.lines_processed;
            status.entries_indexed = outcome.entries_indexed;
            status.current_file = None;
            status.cancelled = false;
        });
    }

    pub fn mark_cancelled(&self, outcome: &SyncOutcome) {
        self.update_status(|status| {
            status.state = "idle".to_string();
            status.files_total = outcome.files_total;
            status.files_processed = outcome.files_processed;
            status.lines_processed = outcome.lines_processed;
            status.entries_indexed = outcome.entries_indexed;
            status.current_file = None;
            status.cancelled = true;
        });
    }

    pub fn mark_error(&self, error: &str) {
        self.update_status(|status| {
            status.state = "error".to_string();
            status.last_error = Some(error.to_string());
            status.current_file = None;
        });
    }
}

pub fn append_usage_debug_log(message: &str) {
    let timestamp = Local::now().to_rfc3339();
    let line = format!("[{}] {}\n", timestamp, message);
    if let Some(home) = dirs::home_dir() {
        let path = home.join(".codeinterfacex-usage-debug.log");
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

pub fn usage_index_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(app_dir.join("usage_index.sqlite"))
}

pub fn open_usage_index_connection(app: &AppHandle) -> Result<Connection, String> {
    let db_path = usage_index_db_path(app)?;
    append_usage_debug_log(&format!(
        "open_usage_index_connection path={}",
        db_path.display()
    ));
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open usage index db: {}", e))?;
    if let Err(err) = conn.pragma_update(None, "journal_mode", "WAL") {
        append_usage_debug_log(&format!("usage_index warning: failed to set WAL mode: {}", err));
    }
    if let Err(err) = conn.execute("PRAGMA synchronous=NORMAL", []) {
        append_usage_debug_log(&format!(
            "usage_index warning: failed to set synchronous mode: {}",
            err
        ));
    }
    if let Err(err) = conn.execute("PRAGMA foreign_keys=ON", []) {
        append_usage_debug_log(&format!(
            "usage_index warning: failed to enable foreign keys: {}",
            err
        ));
    }
    schema::ensure_schema(&conn)?;
    append_usage_debug_log("open_usage_index_connection ready");
    Ok(conn)
}
