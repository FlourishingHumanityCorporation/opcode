use axum::extract::ws::{Message, WebSocket};
use axum::http::Method;
use axum::{
    extract::{Path, State as AxumState, WebSocketUpgrade},
    response::{Html, Json, Response},
    routing::get,
    Router,
};
use chrono;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use which;

use crate::commands;

// Find Claude binary for web mode - use bundled binary first
fn find_claude_binary_web() -> Result<String, String> {
    // First try the bundled binary (same location as Tauri app uses)
    let bundled_binary = "src-tauri/binaries/claude-code-x86_64-unknown-linux-gnu";
    if std::path::Path::new(bundled_binary).exists() {
        println!(
            "[find_claude_binary_web] Using bundled binary: {}",
            bundled_binary
        );
        return Ok(bundled_binary.to_string());
    }

    // Fall back to system installation paths
    let home_path = format!(
        "{}/.local/bin/claude",
        std::env::var("HOME").unwrap_or_default()
    );
    let candidates = vec![
        "claude",
        "claude-code",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        "/opt/homebrew/bin/claude",
        &home_path,
    ];

    for candidate in candidates {
        if which::which(candidate).is_ok() {
            println!(
                "[find_claude_binary_web] Using system binary: {}",
                candidate
            );
            return Ok(candidate.to_string());
        }
    }

    Err("Claude binary not found in bundled location or system paths".to_string())
}

#[derive(Clone)]
pub struct AppState {
    // Track active WebSocket sessions for provider-session execution.
    pub active_sessions:
        Arc<Mutex<std::collections::HashMap<String, tokio::sync::mpsc::Sender<String>>>>,
    // Per-WebSocket-session cancellation signals for currently running provider processes.
    pub active_cancellations:
        Arc<Mutex<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    // Map provider runtime session IDs (session_id) back to WebSocket session IDs.
    pub session_aliases: Arc<Mutex<std::collections::HashMap<String, String>>>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderSessionExecutionRequest {
    pub project_path: String,
    pub prompt: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub command_type: String, // "execute", "continue", or "resume"
}

#[derive(Debug, Clone, Copy)]
enum ProviderSessionCompletionStatus {
    Success,
    Error,
    Cancelled,
}

impl ProviderSessionCompletionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

fn completion_status_for_result(result: &Result<(), String>) -> ProviderSessionCompletionStatus {
    match result {
        Ok(_) => ProviderSessionCompletionStatus::Success,
        Err(error) => {
            let lowered = error.to_ascii_lowercase();
            if lowered.contains("cancelled")
                || lowered.contains("canceled")
                || lowered.contains("interrupted")
            {
                ProviderSessionCompletionStatus::Cancelled
            } else {
                ProviderSessionCompletionStatus::Error
            }
        }
    }
}

async fn register_provider_session_alias(
    state: &AppState,
    provider_session_id: &str,
    websocket_session_id: &str,
) {
    let trimmed = provider_session_id.trim();
    if trimmed.is_empty() {
        return;
    }

    let mut aliases = state.session_aliases.lock().await;
    aliases.insert(trimmed.to_string(), websocket_session_id.to_string());
}

async fn resolve_websocket_session_id(
    state: &AppState,
    requested_session_id: &str,
) -> Option<String> {
    if requested_session_id.trim().is_empty() {
        return None;
    }

    {
        let sessions = state.active_sessions.lock().await;
        if sessions.contains_key(requested_session_id) {
            return Some(requested_session_id.to_string());
        }
    }

    let aliases = state.session_aliases.lock().await;
    aliases.get(requested_session_id).cloned()
}

async fn resolve_provider_session_id_for_websocket(
    state: &AppState,
    websocket_session_id: &str,
) -> Option<String> {
    let aliases = state.session_aliases.lock().await;
    aliases
        .iter()
        .find_map(|(provider_session_id, mapped_websocket_session_id)| {
            if mapped_websocket_session_id == websocket_session_id {
                Some(provider_session_id.clone())
            } else {
                None
            }
        })
}

async fn remove_websocket_session_state(state: &AppState, websocket_session_id: &str) {
    {
        let mut sessions = state.active_sessions.lock().await;
        sessions.remove(websocket_session_id);
    }
    {
        let mut cancellations = state.active_cancellations.lock().await;
        cancellations.remove(websocket_session_id);
    }
    {
        let mut aliases = state.session_aliases.lock().await;
        aliases.retain(|_, mapped_session_id| mapped_session_id != websocket_session_id);
    }
}

#[derive(Deserialize)]
pub struct QueryParams {
    #[serde(default)]
    pub project_path: Option<String>,
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(error: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error),
        }
    }
}

/// Serve the React frontend
async fn serve_frontend() -> Html<&'static str> {
    Html(include_str!("../../dist/index.html"))
}

/// API endpoint to get projects (equivalent to Tauri command)
async fn get_projects() -> Json<ApiResponse<Vec<commands::claude::Project>>> {
    match commands::claude::list_projects().await {
        Ok(projects) => Json(ApiResponse::success(projects)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// API endpoint to get sessions for a project
async fn get_sessions(
    Path(project_id): Path<String>,
) -> Json<ApiResponse<Vec<commands::claude::Session>>> {
    match commands::claude::get_project_sessions(project_id).await {
        Ok(sessions) => Json(ApiResponse::success(sessions)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// Simple agents endpoint - return empty for now (needs DB state)
async fn get_agents() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// List provider runtime capabilities.
async fn list_provider_capabilities(
) -> Json<ApiResponse<Vec<crate::providers::runtime::ProviderCapability>>> {
    Json(ApiResponse::success(
        crate::providers::runtime::list_provider_capabilities(),
    ))
}

/// Simple usage endpoint - return empty for now
async fn get_usage() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// Simple usage range endpoint - return empty for now
async fn get_usage_range() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// Simple usage sessions endpoint - return empty for now
async fn get_usage_sessions() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// Simple usage details endpoint - return empty for now
async fn get_usage_details() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// Usage index status endpoint - return idle defaults for web mode
async fn get_usage_index_status() -> Json<ApiResponse<serde_json::Value>> {
    Json(ApiResponse::success(serde_json::json!({
        "state": "idle",
        "files_total": 0,
        "files_processed": 0,
        "lines_processed": 0,
        "entries_indexed": 0,
        "cancelled": false
    })))
}

/// Start usage index sync endpoint - no-op in web mode
async fn start_usage_index_sync() -> Json<ApiResponse<serde_json::Value>> {
    get_usage_index_status().await
}

/// Cancel usage index sync endpoint - no-op in web mode
async fn cancel_usage_index_sync() -> Json<ApiResponse<serde_json::Value>> {
    get_usage_index_status().await
}

/// Get Claude settings - return basic defaults for web mode
async fn get_claude_settings() -> Json<ApiResponse<serde_json::Value>> {
    let default_settings = serde_json::json!({
        "data": {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 8192,
            "temperature": 0.0,
            "auto_save": true,
            "theme": "dark"
        }
    });
    Json(ApiResponse::success(default_settings))
}

/// Check Claude version - return mock status for web mode
async fn check_claude_version() -> Json<ApiResponse<serde_json::Value>> {
    let version_status = serde_json::json!({
        "status": "ok",
        "version": "web-mode",
        "message": "Running in web server mode"
    });
    Json(ApiResponse::success(version_status))
}

/// List all available Claude installations on the system
async fn list_claude_installations(
) -> Json<ApiResponse<Vec<crate::claude_binary::ClaudeInstallation>>> {
    let installations = crate::claude_binary::discover_claude_installations();

    if installations.is_empty() {
        Json(ApiResponse::error(
            "No Claude Code installations found on the system".to_string(),
        ))
    } else {
        Json(ApiResponse::success(installations))
    }
}

/// Get system prompt - return default for web mode
async fn get_system_prompt() -> Json<ApiResponse<String>> {
    let default_prompt =
        "You are Claude, an AI assistant created by Anthropic. You are running in web server mode."
            .to_string();
    Json(ApiResponse::success(default_prompt))
}

/// Open new provider session - mock for web mode
async fn open_provider_session() -> Json<ApiResponse<String>> {
    let session_id = format!("web-session-{}", chrono::Utc::now().timestamp());
    Json(ApiResponse::success(session_id))
}

/// List slash commands - return empty for web mode
async fn list_slash_commands() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// MCP list servers - return empty for web mode
async fn mcp_list() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    Json(ApiResponse::success(vec![]))
}

/// Load provider session history from JSONL file
async fn load_provider_session_history(
    Path((session_id, project_id)): Path<(String, String)>,
) -> Json<ApiResponse<Vec<serde_json::Value>>> {
    match commands::claude::load_provider_session_history(session_id, project_id).await {
        Ok(history) => Json(ApiResponse::success(history)),
        Err(e) => Json(ApiResponse::error(e.to_string())),
    }
}

/// List running Claude sessions
async fn list_running_provider_sessions() -> Json<ApiResponse<Vec<serde_json::Value>>> {
    // Return empty for web mode - no actual Claude processes in web mode
    Json(ApiResponse::success(vec![]))
}

/// Execute provider session - mock for web mode.
async fn execute_provider_session() -> Json<ApiResponse<serde_json::Value>> {
    Json(ApiResponse::error("Claude execution is not available in web mode. Please use the desktop app for running Claude commands.".to_string()))
}

/// Continue provider session - mock for web mode.
async fn continue_provider_session() -> Json<ApiResponse<serde_json::Value>> {
    Json(ApiResponse::error("Claude execution is not available in web mode. Please use the desktop app for running Claude commands.".to_string()))
}

/// Resume provider session - mock for web mode.
async fn resume_provider_session() -> Json<ApiResponse<serde_json::Value>> {
    Json(ApiResponse::error("Claude execution is not available in web mode. Please use the desktop app for running Claude commands.".to_string()))
}

/// Cancel provider session execution.
async fn cancel_provider_session(
    Path(session_id): Path<String>,
    AxumState(state): AxumState<AppState>,
) -> Json<ApiResponse<()>> {
    println!("[TRACE] Cancel request for session: {}", session_id);

    let Some(websocket_session_id) = resolve_websocket_session_id(&state, &session_id).await else {
        return Json(ApiResponse::error(format!(
            "Provider session is not running: {}",
            session_id
        )));
    };

    let cancellation_sender = {
        let cancellations = state.active_cancellations.lock().await;
        cancellations.get(&websocket_session_id).cloned()
    };

    let Some(cancellation_sender) = cancellation_sender else {
        return Json(ApiResponse::error(format!(
            "Provider session is not running: {}",
            session_id
        )));
    };

    if cancellation_sender.send(true).is_err() {
        return Json(ApiResponse::error(format!(
            "Provider session is not running: {}",
            session_id
        )));
    }

    Json(ApiResponse::success(()))
}

/// Get provider session output.
async fn get_provider_session_output(Path(session_id): Path<String>) -> Json<ApiResponse<String>> {
    // In web mode, output is streamed via WebSocket, not stored
    println!("[TRACE] Output request for session: {}", session_id);
    Json(ApiResponse::success(
        "Output available via WebSocket only".to_string(),
    ))
}

/// WebSocket handler for provider-session execution with streaming output.
async fn provider_session_websocket(ws: WebSocketUpgrade, AxumState(state): AxumState<AppState>) -> Response {
    ws.on_upgrade(move |socket| provider_session_websocket_handler(socket, state))
}

async fn provider_session_websocket_handler(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let websocket_session_id = uuid::Uuid::new_v4().to_string();

    println!(
        "[TRACE] WebSocket handler started - session_id: {}",
        websocket_session_id
    );

    // Channel for sending output to WebSocket
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

    // Store session in state
    {
        let mut sessions = state.active_sessions.lock().await;
        sessions.insert(websocket_session_id.clone(), tx);
        println!(
            "[TRACE] Session stored in state - active sessions count: {}",
            sessions.len()
        );
    }

    // Task to forward channel messages to WebSocket
    let session_id_for_forward = websocket_session_id.clone();
    let forward_task = tokio::spawn(async move {
        println!(
            "[TRACE] Forward task started for session {}",
            session_id_for_forward
        );
        while let Some(message) = rx.recv().await {
            println!("[TRACE] Forwarding message to WebSocket: {}", message);
            if sender.send(Message::Text(message.into())).await.is_err() {
                println!("[TRACE] Failed to send message to WebSocket - connection closed");
                break;
            }
        }
        println!(
            "[TRACE] Forward task ended for session {}",
            session_id_for_forward
        );
    });

    // Handle incoming messages from WebSocket
    println!("[TRACE] Starting to listen for WebSocket messages");
    while let Some(msg) = receiver.next().await {
        println!("[TRACE] Received WebSocket message: {:?}", msg);
        if let Ok(msg) = msg {
            if let Message::Text(text) = msg {
                println!(
                    "[TRACE] WebSocket text message received - length: {} chars",
                    text.len()
                );
                println!("[TRACE] WebSocket message content: {}", text);
                match serde_json::from_str::<ProviderSessionExecutionRequest>(&text) {
                    Ok(request) => {
                        println!("[TRACE] Successfully parsed request: {:?}", request);
                        println!("[TRACE] Command type: {}", request.command_type);
                        println!("[TRACE] Project path: {}", request.project_path);
                        println!("[TRACE] Prompt length: {} chars", request.prompt.len());

                        if request.command_type == "resume" {
                            if let Some(provider_session_id) = request.session_id.as_deref() {
                                register_provider_session_alias(
                                    &state,
                                    provider_session_id,
                                    &websocket_session_id,
                                )
                                .await;
                            }
                        }

                        // Execute provider session command based on request type.
                        let websocket_session_id_clone = websocket_session_id.clone();
                        let state_clone = state.clone();
                        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);

                        {
                            let mut cancellations = state.active_cancellations.lock().await;
                            cancellations.insert(websocket_session_id_clone.clone(), cancel_tx);
                        }

                        println!(
                            "[TRACE] Spawning task to execute command: {}",
                            request.command_type
                        );
                        tokio::spawn(async move {
                            println!("[TRACE] Task started for command execution");
                            let request_session_id = request.session_id.clone();
                            let result = match request.command_type.as_str() {
                                "execute" => {
                                    println!("[TRACE] Calling execute_provider_session_command");
                                    execute_provider_session_command(
                                        request.project_path,
                                        request.prompt,
                                        request.model.unwrap_or_default(),
                                        websocket_session_id_clone.clone(),
                                        state_clone.clone(),
                                        cancel_rx.clone(),
                                    )
                                    .await
                                }
                                "continue" => {
                                    println!("[TRACE] Calling continue_provider_session_command");
                                    continue_provider_session_command(
                                        request.project_path,
                                        request.prompt,
                                        request.model.unwrap_or_default(),
                                        websocket_session_id_clone.clone(),
                                        state_clone.clone(),
                                        cancel_rx.clone(),
                                    )
                                    .await
                                }
                                "resume" => {
                                    println!("[TRACE] Calling resume_provider_session_command");
                                    resume_provider_session_command(
                                        request.project_path,
                                        request.session_id.unwrap_or_default(),
                                        request.prompt,
                                        request.model.unwrap_or_default(),
                                        websocket_session_id_clone.clone(),
                                        state_clone.clone(),
                                        cancel_rx.clone(),
                                    )
                                    .await
                                }
                                _ => {
                                    println!(
                                        "[TRACE] Unknown command type: {}",
                                        request.command_type
                                    );
                                    Err("Unknown command type".to_string())
                                }
                            };

                            println!(
                                "[TRACE] Command execution finished with result: {:?}",
                                result
                            );

                            // Send completion message
                            let completion_sender = {
                                let sessions = state_clone.active_sessions.lock().await;
                                sessions.get(&websocket_session_id_clone).cloned()
                            };
                            if let Some(sender) = completion_sender {
                                let status = completion_status_for_result(&result).as_str();
                                let completion_session_id =
                                    resolve_provider_session_id_for_websocket(
                                        &state_clone,
                                        &websocket_session_id_clone,
                                    )
                                    .await
                                    .or_else(|| {
                                        request_session_id
                                            .as_deref()
                                            .map(str::trim)
                                            .filter(|value| !value.is_empty())
                                            .map(ToOwned::to_owned)
                                    });
                                let completion_msg = match result {
                                    Ok(_) => json!({
                                        "type": "completion",
                                        "status": status,
                                        "session_id": completion_session_id
                                    }),
                                    Err(e) => json!({
                                        "type": "completion",
                                        "status": status,
                                        "error": e,
                                        "session_id": completion_session_id
                                    }),
                                };
                                println!("[TRACE] Sending completion message: {}", completion_msg);
                                let _ = sender.send(completion_msg.to_string()).await;
                            } else {
                                println!("[TRACE] Session not found in active sessions when sending completion");
                            }

                            let mut cancellations = state_clone.active_cancellations.lock().await;
                            cancellations.remove(&websocket_session_id_clone);
                        });
                    }
                    Err(e) => {
                        println!("[TRACE] Failed to parse WebSocket request: {}", e);
                        println!("[TRACE] Raw message that failed to parse: {}", text);

                        // Send error back to client
                        let error_msg = json!({
                            "type": "error",
                            "message": format!("Failed to parse request: {}", e)
                        });
                        let sender_tx = {
                            let sessions = state.active_sessions.lock().await;
                            sessions.get(&websocket_session_id).cloned()
                        };
                        if let Some(sender_tx) = sender_tx {
                            let _ = sender_tx.send(error_msg.to_string()).await;
                        }
                    }
                }
            } else if let Message::Close(_) = msg {
                println!("[TRACE] WebSocket close message received");
                break;
            } else {
                println!("[TRACE] Non-text WebSocket message received: {:?}", msg);
            }
        } else {
            println!("[TRACE] Error receiving WebSocket message");
        }
    }

    println!("[TRACE] WebSocket message loop ended");

    // Clean up session
    if let Some(cancellation_sender) = state
        .active_cancellations
        .lock()
        .await
        .get(&websocket_session_id)
        .cloned()
    {
        let _ = cancellation_sender.send(true);
    }

    remove_websocket_session_state(&state, &websocket_session_id).await;
    println!(
        "[TRACE] Session {} removed from state",
        websocket_session_id
    );

    forward_task.abort();
    println!(
        "[TRACE] WebSocket handler ended for session {}",
        websocket_session_id
    );
}

// Provider-session command execution functions for WebSocket streaming
fn append_optional_model_arg(args: &mut Vec<String>, model: &str) {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
        return;
    }

    args.extend_from_slice(&["--model".to_string(), trimmed.to_string()]);
}

fn extract_provider_session_id_from_stream_line(line: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(line).ok()?;
    let message_type = parsed.get("type")?.as_str()?;
    if message_type != "system" {
        return None;
    }
    let subtype = parsed.get("subtype")?.as_str()?;
    if subtype != "init" {
        return None;
    }
    parsed
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn spawn_provider_process_output_tasks(
    child: &mut tokio::process::Child,
    websocket_session_id: &str,
    state: &AppState,
) -> Result<(tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    let websocket_session_id_stdout = websocket_session_id.to_string();
    let state_stdout = state.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(provider_session_id) = extract_provider_session_id_from_stream_line(&line) {
                register_provider_session_alias(
                    &state_stdout,
                    &provider_session_id,
                    &websocket_session_id_stdout,
                )
                .await;
            }
            send_to_session(
                &state_stdout,
                &websocket_session_id_stdout,
                json!({
                    "type": "output",
                    "content": line
                })
                .to_string(),
            )
            .await;
        }
    });

    let websocket_session_id_stderr = websocket_session_id.to_string();
    let state_stderr = state.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            send_to_session(
                &state_stderr,
                &websocket_session_id_stderr,
                json!({
                    "type": "error",
                    "message": line
                })
                .to_string(),
            )
            .await;
        }
    });

    Ok((stdout_task, stderr_task))
}

enum ProviderProcessOutcome {
    Exited(std::process::ExitStatus),
    Cancelled(std::process::ExitStatus),
}

async fn wait_for_provider_process_completion(
    child: &mut tokio::process::Child,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<ProviderProcessOutcome, String> {
    loop {
        tokio::select! {
            wait_result = child.wait() => {
                let exit_status = wait_result.map_err(|error| {
                    format!("Failed to wait for provider process: {}", error)
                })?;
                return Ok(ProviderProcessOutcome::Exited(exit_status));
            }
            cancel_result = cancel_rx.changed() => {
                if cancel_result.is_err() {
                    continue;
                }
                if !*cancel_rx.borrow() {
                    continue;
                }

                match child.kill().await {
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {}
                    Err(error) => {
                        return Err(format!("Failed to cancel provider session: {}", error));
                    }
                }

                let exit_status = child.wait().await.map_err(|error| {
                    format!("Failed waiting for cancelled provider session: {}", error)
                })?;
                return Ok(ProviderProcessOutcome::Cancelled(exit_status));
            }
        }
    }
}

fn map_exit_status_to_result(exit_status: std::process::ExitStatus) -> Result<(), String> {
    if exit_status.success() {
        return Ok(());
    }

    let code = exit_status.code();
    if matches!(code, Some(130) | Some(143)) {
        return Err(format!("Provider session cancelled (exit code: {:?})", code));
    }

    Err(format!(
        "Provider session execution failed with exit code: {:?}",
        code
    ))
}

async fn execute_provider_session_command(
    project_path: String,
    prompt: String,
    model: String,
    websocket_session_id: String,
    state: AppState,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use tokio::process::Command;

    println!("[TRACE] execute_provider_session_command called:");
    println!("[TRACE]   project_path: {}", project_path);
    println!("[TRACE]   prompt length: {} chars", prompt.len());
    println!("[TRACE]   model: {}", model);
    println!("[TRACE]   websocket_session_id: {}", websocket_session_id);

    // Send initial message
    println!("[TRACE] Sending initial start message");
    send_to_session(
        &state,
        &websocket_session_id,
        json!({
            "type": "start",
            "message": "Starting provider session..."
        })
        .to_string(),
    )
    .await;

    // Find Claude binary (simplified for web mode)
    println!("[TRACE] Finding Claude binary...");
    let claude_path = find_claude_binary_web().map_err(|e| {
        let error = format!("Claude binary not found: {}", e);
        println!("[TRACE] Error finding Claude binary: {}", error);
        error
    })?;
    println!("[TRACE] Found Claude binary: {}", claude_path);

    // Create Claude command
    println!("[TRACE] Creating Claude command...");
    let mut cmd = Command::new(&claude_path);
    let mut args = vec!["-p".to_string(), prompt.clone()];
    append_optional_model_arg(&mut args, &model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);
    cmd.args(&args);
    cmd.current_dir(&project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    println!(
        "[TRACE] Command: {} {:?} (in dir: {})",
        claude_path, args, project_path
    );

    // Spawn Claude process
    println!("[TRACE] Spawning Claude process...");
    let mut child = cmd.spawn().map_err(|e| {
        let error = format!("Failed to spawn Claude: {}", e);
        println!("[TRACE] Spawn error: {}", error);
        error
    })?;
    println!("[TRACE] Claude process spawned successfully");

    let (stdout_task, stderr_task) =
        spawn_provider_process_output_tasks(&mut child, &websocket_session_id, &state)?;

    println!("[TRACE] Waiting for provider process completion or cancellation...");
    let completion = wait_for_provider_process_completion(&mut child, &mut cancel_rx).await;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let completion = completion?;

    let result = match completion {
        ProviderProcessOutcome::Cancelled(exit_status) => {
            println!(
                "[TRACE] Provider session cancelled with status: {:?}",
                exit_status
            );
            Err("Provider session cancelled".to_string())
        }
        ProviderProcessOutcome::Exited(exit_status) => {
            println!(
                "[TRACE] Provider process completed with status: {:?}",
                exit_status
            );
            map_exit_status_to_result(exit_status)
        }
    };

    if let Err(error) = &result {
        println!("[TRACE] Provider session execution failed: {}", error);
    }
    println!("[TRACE] execute_provider_session_command completed");
    result
}

async fn continue_provider_session_command(
    project_path: String,
    prompt: String,
    model: String,
    websocket_session_id: String,
    state: AppState,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use tokio::process::Command;

    send_to_session(
        &state,
        &websocket_session_id,
        json!({
            "type": "start",
            "message": "Continuing provider session..."
        })
        .to_string(),
    )
    .await;

    // Find Claude binary
    let claude_path =
        find_claude_binary_web().map_err(|e| format!("Claude binary not found: {}", e))?;

    // Create continue command
    let mut cmd = Command::new(&claude_path);
    let mut args = vec![
        "-c".to_string(), // Continue flag
        "-p".to_string(),
        prompt.clone(),
    ];
    append_optional_model_arg(&mut args, &model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);
    cmd.args(&args);
    cmd.current_dir(&project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Spawn and stream output
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude: {}", e))?;
    let (stdout_task, stderr_task) =
        spawn_provider_process_output_tasks(&mut child, &websocket_session_id, &state)?;
    let completion = wait_for_provider_process_completion(&mut child, &mut cancel_rx).await;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    match completion? {
        ProviderProcessOutcome::Cancelled(_) => Err("Provider session cancelled".to_string()),
        ProviderProcessOutcome::Exited(exit_status) => map_exit_status_to_result(exit_status),
    }
}

async fn resume_provider_session_command(
    project_path: String,
    provider_session_id: String,
    prompt: String,
    model: String,
    websocket_session_id: String,
    state: AppState,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use tokio::process::Command;

    println!("[resume_provider_session_command] Starting with project_path: {}, provider_session_id: {}, prompt: {}, model: {}",
             project_path, provider_session_id, prompt, model);

    send_to_session(
        &state,
        &websocket_session_id,
        json!({
            "type": "start",
            "message": "Resuming provider session..."
        })
        .to_string(),
    )
    .await;

    // Find Claude binary
    println!("[resume_provider_session_command] Finding Claude binary...");
    let claude_path =
        find_claude_binary_web().map_err(|e| format!("Claude binary not found: {}", e))?;
    println!(
        "[resume_provider_session_command] Found Claude binary: {}",
        claude_path
    );

    // Create resume command
    println!("[resume_provider_session_command] Creating command...");
    let mut cmd = Command::new(&claude_path);
    let mut args = vec![
        "--resume".to_string(),
        provider_session_id.clone(),
        "-p".to_string(),
        prompt.clone(),
    ];
    append_optional_model_arg(&mut args, &model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);
    cmd.args(&args);
    cmd.current_dir(&project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    println!(
        "[resume_provider_session_command] Command: {} {:?} (in dir: {})",
        claude_path, args, project_path
    );

    // Spawn and stream output
    println!("[resume_provider_session_command] Spawning process...");
    let mut child = cmd.spawn().map_err(|e| {
        let error = format!("Failed to spawn Claude: {}", e);
        println!("[resume_provider_session_command] Spawn error: {}", error);
        error
    })?;
    println!("[resume_provider_session_command] Process spawned successfully");
    let (stdout_task, stderr_task) =
        spawn_provider_process_output_tasks(&mut child, &websocket_session_id, &state)?;
    let completion = wait_for_provider_process_completion(&mut child, &mut cancel_rx).await;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    match completion? {
        ProviderProcessOutcome::Cancelled(_) => Err("Provider session cancelled".to_string()),
        ProviderProcessOutcome::Exited(exit_status) => map_exit_status_to_result(exit_status),
    }
}

async fn send_to_session(state: &AppState, session_id: &str, message: String) {
    println!("[TRACE] send_to_session called for session: {}", session_id);
    println!("[TRACE] Message: {}", message);

    let sender = {
        let sessions = state.active_sessions.lock().await;
        sessions.get(session_id).cloned()
    };
    if let Some(sender) = sender {
        println!("[TRACE] Found session in active sessions, sending message...");
        match sender.send(message).await {
            Ok(_) => println!("[TRACE] Message sent successfully"),
            Err(e) => println!("[TRACE] Failed to send message: {}", e),
        }
    } else {
        let active_session_ids = {
            let sessions = state.active_sessions.lock().await;
            sessions.keys().cloned().collect::<Vec<_>>()
        };
        println!(
            "[TRACE] Session {} not found in active sessions",
            session_id
        );
        println!("[TRACE] Active sessions: {:?}", active_session_ids);
    }
}

/// Create the web server
pub async fn create_web_server(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let state = AppState {
        active_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        active_cancellations: Arc::new(Mutex::new(std::collections::HashMap::new())),
        session_aliases: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    // CORS layer to allow requests from phone browsers
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any);

    // Create router with API endpoints
    let app = Router::new()
        // Frontend routes
        .route("/", get(serve_frontend))
        .route("/index.html", get(serve_frontend))
        // API routes (REST API equivalent of Tauri commands)
        .route("/api/projects", get(get_projects))
        .route("/api/projects/{project_id}/sessions", get(get_sessions))
        .route("/api/agents", get(get_agents))
        .route("/api/providers/capabilities", get(list_provider_capabilities))
        .route("/api/usage", get(get_usage))
        .route("/api/usage/range", get(get_usage_range))
        .route("/api/usage/sessions", get(get_usage_sessions))
        .route("/api/usage/details", get(get_usage_details))
        .route("/api/usage/index/status", get(get_usage_index_status))
        .route("/api/usage/index/sync", get(start_usage_index_sync))
        .route("/api/usage/index/cancel", get(cancel_usage_index_sync))
        // Settings and configuration
        .route("/api/settings/claude", get(get_claude_settings))
        .route("/api/settings/claude/version", get(check_claude_version))
        .route(
            "/api/settings/claude/installations",
            get(list_claude_installations),
        )
        .route("/api/settings/system-prompt", get(get_system_prompt))
        // Session management
        .route("/api/provider-sessions/new", get(open_provider_session))
        // Slash commands
        .route("/api/slash-commands", get(list_slash_commands))
        // MCP
        .route("/api/mcp/servers", get(mcp_list))
        // Session history
        .route(
            "/api/provider-sessions/{session_id}/history/{project_id}",
            get(load_provider_session_history),
        )
        .route("/api/provider-sessions/running", get(list_running_provider_sessions))
        // Claude execution endpoints (read-only in web mode)
        .route("/api/provider-sessions/execute", get(execute_provider_session))
        .route("/api/provider-sessions/continue", get(continue_provider_session))
        .route("/api/provider-sessions/resume", get(resume_provider_session))
        .route(
            "/api/provider-sessions/{sessionId}/cancel",
            get(cancel_provider_session),
        )
        .route(
            "/api/provider-sessions/{sessionId}/output",
            get(get_provider_session_output),
        )
        // WebSocket endpoint for real-time Claude execution
        .route("/ws/provider-session", get(provider_session_websocket))
        // Serve static assets
        .nest_service("/assets", ServeDir::new("../dist/assets"))
        .nest_service("/vite.svg", ServeDir::new("../dist/vite.svg"))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("🌐 Web server running on http://0.0.0.0:{}", port);
    println!("📱 Access from phone: http://YOUR_PC_IP:{}", port);

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Start web server mode (alternative to Tauri GUI)
pub async fn start_web_mode(port: Option<u16>) -> Result<(), Box<dyn std::error::Error>> {
    let port = port.unwrap_or(8080);

    println!("🚀 Starting Opcode in web server mode...");
    create_web_server(port).await
}
