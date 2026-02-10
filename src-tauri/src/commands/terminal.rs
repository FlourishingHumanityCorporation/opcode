use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const CODEINTERFACEX_TMUX_SOCKET: &str = "codeinterfacex_persistent";
const TMUX_HISTORY_LIMIT: &str = "200000";

#[cfg(target_os = "windows")]
const TMUX_CONFIG_PATH: &str = "NUL";
#[cfg(not(target_os = "windows"))]
const TMUX_CONFIG_PATH: &str = "/dev/null";

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send>,
    persistent_session_id: Option<String>,
    debug_meta: TerminalSessionDebugMeta,
}

#[derive(Clone, Default)]
struct TerminalSessionDebugMeta {
    created_at_ms: u64,
    last_input_write_ms: Option<u64>,
    last_resize_ms: Option<u64>,
    last_read_output_ms: Option<u64>,
    last_read_err: Option<String>,
    last_write_err: Option<String>,
    last_exit_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartEmbeddedTerminalResult {
    terminal_id: String,
    reused_existing_session: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTerminalDebugSession {
    terminal_id: String,
    persistent_session_id: Option<String>,
    alive: bool,
    created_at_ms: u64,
    last_input_write_ms: Option<u64>,
    last_resize_ms: Option<u64>,
    last_read_output_ms: Option<u64>,
    last_read_err: Option<String>,
    last_write_err: Option<String>,
    last_exit_reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTerminalDebugSnapshot {
    captured_at_ms: u64,
    session_count: usize,
    sessions: Vec<EmbeddedTerminalDebugSession>,
}

#[derive(Clone, Default)]
pub struct EmbeddedTerminalState(Arc<Mutex<HashMap<String, Arc<Mutex<TerminalSession>>>>>);

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn missing_terminal_session_error(terminal_id: &str) -> String {
    format!(
        "ERR_SESSION_NOT_FOUND: Terminal session not found: {}",
        terminal_id
    )
}

fn mark_input_write_result(meta: &mut TerminalSessionDebugMeta, error: Option<String>) {
    meta.last_input_write_ms = Some(unix_timestamp_ms());
    meta.last_write_err = error;
}

fn mark_resize(meta: &mut TerminalSessionDebugMeta) {
    meta.last_resize_ms = Some(unix_timestamp_ms());
}

fn mark_output_read(meta: &mut TerminalSessionDebugMeta) {
    meta.last_read_output_ms = Some(unix_timestamp_ms());
    meta.last_read_err = None;
}

fn mark_read_error(meta: &mut TerminalSessionDebugMeta, error: String) {
    meta.last_read_err = Some(error);
}

fn mark_exit_reason(meta: &mut TerminalSessionDebugMeta, reason: &str) {
    meta.last_exit_reason = Some(reason.to_string());
}

fn prune_incident_files(dir: &Path, keep: usize) {
    let mut files = match fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("incident-")
            })
            .collect::<Vec<_>>(),
        Err(_) => return,
    };

    files.sort_by_key(|entry| {
        entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(UNIX_EPOCH)
    });

    if files.len() <= keep {
        return;
    }

    let remove_count = files.len().saturating_sub(keep);
    for entry in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(entry.path());
    }
}

fn resolve_default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

fn shell_name(shell_path: &str) -> String {
    Path::new(shell_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell_path)
        .to_ascii_lowercase()
}

fn sanitize_persistent_session_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let sanitized: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn start_tmux_attached(command: &mut CommandBuilder, session_id: &str, cwd: &Path) {
    let shell = resolve_default_shell();
    let shell_kind = shell_name(&shell);

    command.args(["-L", CODEINTERFACEX_TMUX_SOCKET, "-f", TMUX_CONFIG_PATH]);
    command.args(["new-session", "-A", "-s", session_id, "-c"]);
    command.arg(cwd.to_string_lossy().to_string());
    command.arg(shell);
    match shell_kind.as_str() {
        "zsh" | "bash" | "sh" => command.args(["-il"]),
        "fish" => command.arg("-l"),
        _ => command.arg("-i"),
    }
}

fn run_tmux_command(args: &[&str]) -> Option<std::process::ExitStatus> {
    ProcessCommand::new("tmux")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .args(["-L", CODEINTERFACEX_TMUX_SOCKET, "-f", TMUX_CONFIG_PATH])
        .args(args)
        .status()
        .ok()
}

fn configure_tmux_defaults() {
    let _ = run_tmux_command(&["set-option", "-g", "mouse", "on"]);
    let _ = run_tmux_command(&["set-option", "-g", "history-limit", TMUX_HISTORY_LIMIT]);
    let _ = run_tmux_command(&["set-option", "-g", "status", "off"]);
}

fn kill_tmux_session(session_id: &str) {
    let _ = run_tmux_command(&["kill-session", "-t", session_id]);
}

fn tmux_has_session(session_id: &str) -> bool {
    run_tmux_command(&["has-session", "-t", session_id])
        .map(|status| status.success())
        .unwrap_or(false)
}

fn should_terminate_persistent_session(terminate_persistent_session: Option<bool>) -> bool {
    terminate_persistent_session.unwrap_or(true)
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        if !bytes.is_empty() {
            self.pending.extend_from_slice(bytes);
        }
        self.decode_pending(false)
    }

    fn flush_eof(&mut self) -> String {
        self.decode_pending(true)
    }

    fn decode_pending(&mut self, flush_incomplete: bool) -> String {
        let mut output = String::new();
        let mut cursor = 0usize;

        while cursor < self.pending.len() {
            match std::str::from_utf8(&self.pending[cursor..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    cursor = self.pending.len();
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid_end = cursor + valid_up_to;
                        let valid_slice = &self.pending[cursor..valid_end];
                        let valid_text =
                            std::str::from_utf8(valid_slice).expect("valid UTF-8 slice");
                        output.push_str(valid_text);
                        cursor = valid_end;
                    }

                    match error.error_len() {
                        Some(invalid_len) => {
                            output.push(char::REPLACEMENT_CHARACTER);
                            cursor = (cursor + invalid_len).min(self.pending.len());
                        }
                        None => {
                            if flush_incomplete {
                                output.push(char::REPLACEMENT_CHARACTER);
                                cursor = self.pending.len();
                            }
                            break;
                        }
                    }
                }
            }
        }

        if cursor >= self.pending.len() {
            self.pending.clear();
        } else if cursor > 0 {
            self.pending.drain(..cursor);
        }

        output
    }
}

fn has_non_empty_locale(value: Option<&str>) -> bool {
    value.map(|entry| !entry.trim().is_empty()).unwrap_or(false)
}

fn should_apply_utf8_locale_fallback(
    lang: Option<&str>,
    lc_all: Option<&str>,
    lc_ctype: Option<&str>,
) -> bool {
    !has_non_empty_locale(lang) && !has_non_empty_locale(lc_all) && !has_non_empty_locale(lc_ctype)
}

#[cfg(not(target_os = "windows"))]
fn should_apply_utf8_locale_fallback_from_env() -> bool {
    let lang = std::env::var("LANG").ok();
    let lc_all = std::env::var("LC_ALL").ok();
    let lc_ctype = std::env::var("LC_CTYPE").ok();
    should_apply_utf8_locale_fallback(lang.as_deref(), lc_all.as_deref(), lc_ctype.as_deref())
}

#[cfg(target_os = "windows")]
fn should_apply_utf8_locale_fallback_from_env() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
fn apply_utf8_locale_fallback(command: &mut CommandBuilder) {
    if should_apply_utf8_locale_fallback_from_env() {
        command.env("LANG", "en_US.UTF-8");
        command.env("LC_CTYPE", "en_US.UTF-8");
    }
}

#[cfg(target_os = "windows")]
fn apply_utf8_locale_fallback(_command: &mut CommandBuilder) {}

#[tauri::command]
pub async fn start_embedded_terminal(
    app: AppHandle,
    state: State<'_, EmbeddedTerminalState>,
    project_path: String,
    cols: Option<u16>,
    rows: Option<u16>,
    persistent_session_id: Option<String>,
) -> Result<StartEmbeddedTerminalResult, String> {
    let cwd = PathBuf::from(&project_path);
    if !cwd.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    if !cwd.is_dir() {
        return Err(format!("Project path is not a directory: {}", project_path));
    }

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(30),
            cols: cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to create PTY: {}", e))?;

    let persistent_session_id = persistent_session_id
        .as_deref()
        .and_then(sanitize_persistent_session_id);

    let reused_existing_session = persistent_session_id
        .as_deref()
        .map(tmux_has_session)
        .unwrap_or(false);

    let command = if let Some(session_id) = persistent_session_id.as_deref() {
        configure_tmux_defaults();

        let mut cmd = CommandBuilder::new("tmux");
        cmd.cwd(cwd.clone());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("CLICOLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("FORCE_COLOR", "1");
        cmd.env("TERM_PROGRAM", "codeinterfacex");
        cmd.env_remove("npm_config_prefix");
        cmd.env_remove("NPM_CONFIG_PREFIX");
        cmd.env_remove("PREFIX");
        cmd.env_remove("NO_COLOR");
        cmd.env_remove("ANSI_COLORS_DISABLED");
        apply_utf8_locale_fallback(&mut cmd);
        start_tmux_attached(&mut cmd, session_id, &cwd);
        cmd
    } else {
        let shell = resolve_default_shell();
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd.clone());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("CLICOLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("FORCE_COLOR", "1");
        cmd.env("TERM_PROGRAM", "codeinterfacex");
        cmd.env_remove("npm_config_prefix");
        cmd.env_remove("NPM_CONFIG_PREFIX");
        cmd.env_remove("PREFIX");
        cmd.env_remove("NO_COLOR");
        cmd.env_remove("ANSI_COLORS_DISABLED");
        apply_utf8_locale_fallback(&mut cmd);

        #[cfg(not(target_os = "windows"))]
        {
            let current_shell = cmd.get_argv()[0].to_string_lossy().to_string();
            let shell = shell_name(&current_shell);
            match shell.as_str() {
                "zsh" | "bash" | "sh" => cmd.args(["-il"]),
                "fish" => cmd.arg("-l"),
                _ => cmd.arg("-i"),
            }
        }

        cmd
    };

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to spawn shell in PTY: {}", e))?;

    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to attach PTY writer: {}", e))?;

    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to attach PTY reader: {}", e))?;

    let terminal_id = format!("term-{}", Uuid::new_v4());
    let session = Arc::new(Mutex::new(TerminalSession {
        master: pty_pair.master,
        writer,
        child,
        persistent_session_id,
        debug_meta: TerminalSessionDebugMeta {
            created_at_ms: unix_timestamp_ms(),
            ..TerminalSessionDebugMeta::default()
        },
    }));

    {
        let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(terminal_id.clone(), Arc::clone(&session));
    }

    let app_for_reader = app.clone();
    let terminal_id_for_reader = terminal_id.clone();
    let state_for_reader = state.0.clone();
    let session_for_reader = Arc::clone(&session);

    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let output_event_name = format!("terminal-output:{}", terminal_id_for_reader);
        let mut output_decoder = Utf8StreamDecoder::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read_bytes) => {
                    if let Ok(mut session_guard) = session_for_reader.lock() {
                        mark_output_read(&mut session_guard.debug_meta);
                    }
                    let chunk = output_decoder.push(&buffer[..read_bytes]);
                    if !chunk.is_empty() {
                        let _ = app_for_reader.emit(&output_event_name, chunk);
                    }
                }
                Err(error) => {
                    if let Ok(mut session_guard) = session_for_reader.lock() {
                        mark_read_error(&mut session_guard.debug_meta, error.to_string());
                    }
                    break;
                }
            }
        }

        let final_chunk = output_decoder.flush_eof();
        if !final_chunk.is_empty() {
            let _ = app_for_reader.emit(&output_event_name, final_chunk);
        }

        if let Ok(mut session_guard) = session_for_reader.lock() {
            mark_exit_reason(&mut session_guard.debug_meta, "reader_closed");
        }
        let exit_event_name = format!("terminal-exit:{}", terminal_id_for_reader);
        let _ = app_for_reader.emit(&exit_event_name, true);
        if let Ok(mut sessions) = state_for_reader.lock() {
            sessions.remove(&terminal_id_for_reader);
        }
    });

    Ok(StartEmbeddedTerminalResult {
        terminal_id,
        reused_existing_session,
    })
}

#[tauri::command]
pub async fn write_embedded_terminal_input(
    state: State<'_, EmbeddedTerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let session = {
        let sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| missing_terminal_session_error(&terminal_id))?
    };

    let mut session_guard = session.lock().map_err(|e| e.to_string())?;
    if let Err(error) = session_guard.writer.write_all(data.as_bytes()) {
        mark_input_write_result(&mut session_guard.debug_meta, Some(error.to_string()));
        return Err(format!("ERR_WRITE_FAILED: Failed to write to terminal: {}", error));
    }
    if let Err(error) = session_guard.writer.flush() {
        mark_input_write_result(&mut session_guard.debug_meta, Some(error.to_string()));
        return Err(format!(
            "ERR_WRITE_FAILED: Failed to flush terminal input: {}",
            error
        ));
    }
    mark_input_write_result(&mut session_guard.debug_meta, None);
    Ok(())
}

#[tauri::command]
pub async fn resize_embedded_terminal(
    state: State<'_, EmbeddedTerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = {
        let sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| missing_terminal_session_error(&terminal_id))?
    };

    let mut session_guard = session.lock().map_err(|e| e.to_string())?;
    session_guard
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("ERR_RESIZE_FAILED: Failed to resize terminal: {}", e))?;
    mark_resize(&mut session_guard.debug_meta);
    Ok(())
}

#[tauri::command]
pub async fn close_embedded_terminal(
    state: State<'_, EmbeddedTerminalState>,
    terminal_id: String,
    terminate_persistent_session: Option<bool>,
) -> Result<(), String> {
    let session = {
        let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions.remove(&terminal_id)
    };

    if let Some(session) = session {
        let mut session_guard = session.lock().map_err(|e| e.to_string())?;
        let persistent_session_id = session_guard.persistent_session_id.clone();
        mark_exit_reason(&mut session_guard.debug_meta, "close_command");
        let _ = session_guard.child.kill();
        drop(session_guard);

        if should_terminate_persistent_session(terminate_persistent_session) {
            if let Some(session_id) = persistent_session_id {
                kill_tmux_session(&session_id);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_embedded_terminal_debug_snapshot(
    state: State<'_, EmbeddedTerminalState>,
) -> Result<EmbeddedTerminalDebugSnapshot, String> {
    let session_entries = {
        let sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions
            .iter()
            .map(|(terminal_id, session)| (terminal_id.clone(), Arc::clone(session)))
            .collect::<Vec<_>>()
    };

    let mut session_summaries = Vec::with_capacity(session_entries.len());
    for (terminal_id, session) in session_entries {
        let mut session_guard = session.lock().map_err(|e| e.to_string())?;
        let alive = session_guard
            .child
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false);

        session_summaries.push(EmbeddedTerminalDebugSession {
            terminal_id,
            persistent_session_id: session_guard.persistent_session_id.clone(),
            alive,
            created_at_ms: session_guard.debug_meta.created_at_ms,
            last_input_write_ms: session_guard.debug_meta.last_input_write_ms,
            last_resize_ms: session_guard.debug_meta.last_resize_ms,
            last_read_output_ms: session_guard.debug_meta.last_read_output_ms,
            last_read_err: session_guard.debug_meta.last_read_err.clone(),
            last_write_err: session_guard.debug_meta.last_write_err.clone(),
            last_exit_reason: session_guard.debug_meta.last_exit_reason.clone(),
        });
    }

    Ok(EmbeddedTerminalDebugSnapshot {
        captured_at_ms: unix_timestamp_ms(),
        session_count: session_summaries.len(),
        sessions: session_summaries,
    })
}

#[tauri::command]
pub async fn write_terminal_incident_bundle(
    payload: Value,
    note: Option<String>,
) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let output_dir = home.join(".codeinterfacex-terminal-debug");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Failed to create incident directory: {}", error))?;

    let timestamp_ms = unix_timestamp_ms();
    let file_name = format!("incident-{}-{}.json", timestamp_ms, Uuid::new_v4());
    let output_path = output_dir.join(file_name);

    let body = json!({
        "version": 1,
        "capturedAtMs": timestamp_ms,
        "note": note,
        "payload": payload,
    });
    let serialized = serde_json::to_vec_pretty(&body)
        .map_err(|error| format!("Failed to serialize incident payload: {}", error))?;
    fs::write(&output_path, serialized)
        .map_err(|error| format!("Failed to write incident payload: {}", error))?;

    prune_incident_files(&output_dir, 25);

    Ok(output_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        mark_input_write_result, mark_resize, missing_terminal_session_error,
        should_apply_utf8_locale_fallback, should_terminate_persistent_session,
        EmbeddedTerminalDebugSession, EmbeddedTerminalDebugSnapshot, TerminalSessionDebugMeta,
        Utf8StreamDecoder,
    };

    #[test]
    fn should_terminate_defaults_to_true() {
        assert!(should_terminate_persistent_session(None));
    }

    #[test]
    fn should_terminate_respects_explicit_flag() {
        assert!(should_terminate_persistent_session(Some(true)));
        assert!(!should_terminate_persistent_session(Some(false)));
    }

    #[test]
    fn marks_write_and_resize_metadata() {
        let mut meta = TerminalSessionDebugMeta::default();
        assert!(meta.last_input_write_ms.is_none());
        assert!(meta.last_resize_ms.is_none());

        mark_input_write_result(&mut meta, None);
        mark_resize(&mut meta);

        assert!(meta.last_input_write_ms.is_some());
        assert!(meta.last_resize_ms.is_some());
        assert!(meta.last_write_err.is_none());
    }

    #[test]
    fn serializes_debug_snapshot_shape() {
        let snapshot = EmbeddedTerminalDebugSnapshot {
            captured_at_ms: 123,
            session_count: 1,
            sessions: vec![EmbeddedTerminalDebugSession {
                terminal_id: "term-1".to_string(),
                persistent_session_id: Some("opcode_ws_term_pane".to_string()),
                alive: true,
                created_at_ms: 120,
                last_input_write_ms: Some(121),
                last_resize_ms: Some(122),
                last_read_output_ms: Some(123),
                last_read_err: None,
                last_write_err: None,
                last_exit_reason: None,
            }],
        };

        let json = serde_json::to_value(snapshot).expect("snapshot should serialize");
        assert_eq!(json.get("capturedAtMs").and_then(|v| v.as_u64()), Some(123));
        assert_eq!(json.get("sessionCount").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            json.get("sessions")
                .and_then(|v| v.as_array())
                .and_then(|v| v.first())
                .and_then(|v| v.get("terminalId"))
                .and_then(|v| v.as_str()),
            Some("term-1")
        );
    }

    #[test]
    fn classifies_missing_session_error() {
        let message = missing_terminal_session_error("term-missing");
        assert!(message.starts_with("ERR_SESSION_NOT_FOUND:"));
        assert!(message.contains("term-missing"));
    }

    #[test]
    fn decoder_keeps_split_multibyte_sequence_until_complete() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.push(&[0xE2, 0x94]), "");
        assert_eq!(decoder.push(&[0x94, b' ', b'O', b'K']), "\u{2514} OK");
        assert_eq!(decoder.flush_eof(), "");
    }

    #[test]
    fn decoder_preserves_mixed_ascii_and_split_utf8() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.push(b"abc"), "abc");
        assert_eq!(decoder.push(&[0xF0, 0x9F]), "");
        assert_eq!(decoder.push(&[0x99, 0x82, b'd', b'e', b'f']), "\u{1F642}def");
        assert_eq!(decoder.flush_eof(), "");
    }

    #[test]
    fn decoder_replaces_invalid_bytes_and_continues() {
        let mut decoder = Utf8StreamDecoder::new();
        let expected = format!("f{}o", char::REPLACEMENT_CHARACTER);
        assert_eq!(decoder.push(&[b'f', 0x80, b'o']), expected);
        assert_eq!(decoder.flush_eof(), "");
    }

    #[test]
    fn decoder_replaces_incomplete_sequence_on_eof() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.push(&[0xE2]), "");
        assert_eq!(decoder.flush_eof(), char::REPLACEMENT_CHARACTER.to_string());
    }

    #[test]
    fn locale_fallback_applies_only_when_locale_is_missing() {
        assert!(should_apply_utf8_locale_fallback(None, None, None));
        assert!(should_apply_utf8_locale_fallback(Some(""), None, None));
        assert!(!should_apply_utf8_locale_fallback(Some("en_US.UTF-8"), None, None));
        assert!(!should_apply_utf8_locale_fallback(None, Some("C.UTF-8"), None));
        assert!(!should_apply_utf8_locale_fallback(None, None, Some("en_US.UTF-8")));
    }
}
