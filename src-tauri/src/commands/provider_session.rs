use std::process::Stdio;
use std::sync::Arc;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as TokioMutex;

/// Global state to track the current provider-session process.
pub struct ProviderSessionProcessState {
    pub current_process: Arc<TokioMutex<Option<Child>>>,
}

impl Default for ProviderSessionProcessState {
    fn default() -> Self {
        Self {
            current_process: Arc::new(TokioMutex::new(None)),
        }
    }
}

fn build_provider_session_completion_payload(
    status: &str,
    session_id: Option<&str>,
    provider_id: Option<&str>,
    error: Option<&str>,
) -> serde_json::Value {
    let mut payload = json!({
        "status": status,
        "success": status == "success",
    });

    if let Some(session_id) = session_id {
        payload["sessionId"] = json!(session_id);
    }
    if let Some(provider_id) = provider_id {
        payload["providerId"] = json!(provider_id);
    }
    if let Some(error) = error {
        payload["error"] = json!(error);
    }

    payload
}

fn completion_status_from_exit_status(exit_status: std::process::ExitStatus) -> (&'static str, Option<String>) {
    if exit_status.success() {
        return ("success", None);
    }

    let code = exit_status.code();
    if matches!(code, Some(130) | Some(143)) {
        return ("cancelled", None);
    }

    (
        "error",
        Some(format!(
            "Provider session process exited with status: {}",
            exit_status
        )),
    )
}

/// Helper function to create a tokio Command with proper environment variables.
/// This ensures provider session commands can find Node.js and other dependencies.
fn create_provider_session_command_with_env(program: &str) -> Command {
    // Convert std::process::Command to tokio::process::Command
    let _std_cmd = crate::claude_binary::create_command_with_env(program);

    // Create a new tokio Command from the program path
    let mut tokio_cmd = Command::new(program);

    // Copy over all environment variables
    for (key, value) in std::env::vars() {
        if key == "PATH"
            || key == "HOME"
            || key == "USER"
            || key == "SHELL"
            || key == "LANG"
            || key == "LC_ALL"
            || key.starts_with("LC_")
            || key == "NODE_PATH"
            || key == "NVM_DIR"
            || key == "NVM_BIN"
            || key == "HOMEBREW_PREFIX"
            || key == "HOMEBREW_CELLAR"
        {
            log::debug!("Inheriting env var: {}={}", key, value);
            tokio_cmd.env(&key, &value);
        }
    }

    // Add NVM support if the program is in an NVM directory
    if program.contains("/.nvm/versions/node/") {
        if let Some(node_bin_dir) = std::path::Path::new(program).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let node_bin_str = node_bin_dir.to_string_lossy();
            if !current_path.contains(&node_bin_str.as_ref()) {
                let new_path = format!("{}:{}", node_bin_str, current_path);
                tokio_cmd.env("PATH", new_path);
            }
        }
    }

    // Add Homebrew support if the program is in a Homebrew directory
    if program.contains("/homebrew/") || program.contains("/opt/homebrew/") {
        if let Some(program_dir) = std::path::Path::new(program).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let homebrew_bin_str = program_dir.to_string_lossy();
            if !current_path.contains(&homebrew_bin_str.as_ref()) {
                let new_path = format!("{}:{}", homebrew_bin_str, current_path);
                log::debug!(
                    "Adding Homebrew bin directory to PATH: {}",
                    homebrew_bin_str
                );
                tokio_cmd.env("PATH", new_path);
            }
        }
    }

    tokio_cmd
}

/// Creates a system command with the given arguments for provider sessions.
fn create_provider_session_system_command(
    provider_binary_path: &str,
    args: Vec<String>,
    project_path: &str,
) -> Command {
    let mut cmd = create_provider_session_command_with_env(provider_binary_path);

    // Add all arguments
    for arg in args {
        cmd.arg(arg);
    }

    cmd.current_dir(project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd
}

/// Appends a model argument only when an explicit model is requested.
/// `default` (or empty) means use the provider CLI's configured/recommended default.
fn append_provider_session_model_arg(args: &mut Vec<String>, model: &str) {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
        return;
    }

    args.extend_from_slice(&["--model".to_string(), trimmed.to_string()]);
}

/// Execute a new interactive provider session with streaming output.
#[tauri::command]
pub async fn execute_provider_session(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    log::info!(
        "Starting new provider session in: {} with model: {}",
        project_path,
        model
    );

    let provider_binary_path = crate::claude_binary::find_claude_binary(&app)?;

    let mut args = vec!["-p".to_string(), prompt.clone()];
    append_provider_session_model_arg(&mut args, &model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);

    let cmd = create_provider_session_system_command(&provider_binary_path, args, &project_path);
    spawn_provider_session_process(app, cmd, prompt, model, project_path).await
}

/// Continue an existing interactive provider session with streaming output.
#[tauri::command]
pub async fn continue_provider_session(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    log::info!(
        "Continuing provider session in: {} with model: {}",
        project_path,
        model
    );

    let provider_binary_path = crate::claude_binary::find_claude_binary(&app)?;

    let mut args = vec![
        "-c".to_string(), // Continue flag
        "-p".to_string(),
        prompt.clone(),
    ];
    append_provider_session_model_arg(&mut args, &model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);

    let cmd = create_provider_session_system_command(&provider_binary_path, args, &project_path);
    spawn_provider_session_process(app, cmd, prompt, model, project_path).await
}

/// Resume an existing provider session by ID with streaming output.
#[tauri::command]
pub async fn resume_provider_session(
    app: AppHandle,
    project_path: String,
    session_id: String,
    prompt: String,
    model: String,
) -> Result<(), String> {
    log::info!(
        "Resuming provider session: {} in: {} with model: {}",
        session_id,
        project_path,
        model
    );

    let provider_binary_path = crate::claude_binary::find_claude_binary(&app)?;

    let mut args = vec![
        "--resume".to_string(),
        session_id.clone(),
        "-p".to_string(),
        prompt.clone(),
    ];
    append_provider_session_model_arg(&mut args, &model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);

    let cmd = create_provider_session_system_command(&provider_binary_path, args, &project_path);
    spawn_provider_session_process(app, cmd, prompt, model, project_path).await
}

/// Cancel the currently running provider session execution.
#[tauri::command]
pub async fn cancel_provider_session(
    app: AppHandle,
    session_id: Option<String>,
) -> Result<(), String> {
    log::info!("Cancelling provider session for session: {:?}", session_id);

    let mut killed = false;
    let mut attempted_methods = Vec::new();

    // Method 1: Try to find and kill via ProcessRegistry using session ID
    if let Some(sid) = &session_id {
        let registry = app.state::<crate::process::ProcessRegistryState>();
        match registry.0.get_provider_session_by_id(sid) {
            Ok(Some(process_info)) => {
                log::info!(
                    "Found process in registry for session {}: run_id={}, PID={}",
                    sid,
                    process_info.run_id,
                    process_info.pid
                );
                match registry.0.kill_process(process_info.run_id).await {
                    Ok(success) => {
                        if success {
                            log::info!("Successfully killed process via registry");
                            killed = true;
                        } else {
                            log::warn!("Registry kill returned false");
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to kill via registry: {}", e);
                    }
                }
                attempted_methods.push("registry");
            }
            Ok(None) => {
                log::warn!("Session {} not found in ProcessRegistry", sid);
            }
            Err(e) => {
                log::error!("Error querying ProcessRegistry: {}", e);
            }
        }
    }

    // Method 2: Try to kill via ProviderSessionProcessState
    if !killed {
        let provider_session_state = app.state::<ProviderSessionProcessState>();
        let mut current_process = provider_session_state.current_process.lock().await;

        if let Some(mut child) = current_process.take() {
            // Try to get the PID before killing
            let pid = child.id();
            log::info!(
                "Attempting to kill provider session via state with PID: {:?}",
                pid
            );

            // Kill the process
            match child.kill().await {
                Ok(_) => {
                    log::info!("Successfully killed provider session via state");
                    killed = true;
                }
                Err(e) => {
                    log::error!("Failed to kill provider session via state: {}", e);

                    // Method 3: If we have a PID, try system kill as last resort
                    if let Some(pid) = pid {
                        log::info!("Attempting system kill as last resort for PID: {}", pid);
                        let kill_result = if cfg!(target_os = "windows") {
                            std::process::Command::new("taskkill")
                                .args(["/F", "/PID", &pid.to_string()])
                                .output()
                        } else {
                            std::process::Command::new("kill")
                                .args(["-KILL", &pid.to_string()])
                                .output()
                        };

                        match kill_result {
                            Ok(output) if output.status.success() => {
                                log::info!("Successfully killed process via system command");
                                killed = true;
                            }
                            Ok(output) => {
                                let stderr = String::from_utf8_lossy(&output.stderr);
                                log::error!("System kill failed: {}", stderr);
                            }
                            Err(e) => {
                                log::error!("Failed to execute system kill command: {}", e);
                            }
                        }
                    }
                }
            }
            attempted_methods.push("provider_session_state");
        } else {
            log::warn!("No active provider session process in state");
        }
    }

    if !killed && attempted_methods.is_empty() {
        log::warn!("No active provider session process found to cancel");
    }

    // Always emit cancellation events for UI consistency
    if let Some(sid) = session_id.as_deref() {
        let scoped_completion_payload = build_provider_session_completion_payload(
            "cancelled",
            Some(sid),
            Some("claude"),
            None,
        );
        let _ = app.emit(&format!("provider-session-cancelled:{}", sid), true);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        let _ = app.emit(
            &format!("provider-session-complete:{}", sid),
            scoped_completion_payload,
        );
    }

    // Also emit generic events for backward compatibility
    let generic_completion_payload = build_provider_session_completion_payload(
        "cancelled",
        session_id.as_deref(),
        Some("claude"),
        None,
    );
    let _ = app.emit("provider-session-cancelled", true);
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    let _ = app.emit("provider-session-complete", generic_completion_payload);

    if killed {
        log::info!("Provider session cancellation completed successfully");
    } else if !attempted_methods.is_empty() {
        log::warn!(
            "Provider session cancellation attempted but process may have already exited. Attempted methods: {:?}",
            attempted_methods
        );
    }

    Ok(())
}

/// Get all running provider sessions.
#[tauri::command]
pub async fn list_running_provider_sessions(
    registry: tauri::State<'_, crate::process::ProcessRegistryState>,
) -> Result<Vec<crate::process::ProcessInfo>, String> {
    registry.0.get_running_provider_sessions()
}

/// Get live output from a provider session.
#[tauri::command]
pub async fn get_provider_session_output(
    registry: tauri::State<'_, crate::process::ProcessRegistryState>,
    session_id: String,
) -> Result<String, String> {
    // Find the process by session ID
    if let Some(process_info) = registry.0.get_provider_session_by_id(&session_id)? {
        registry.0.get_live_output(process_info.run_id)
    } else {
        Ok(String::new())
    }
}

/// Helper function to spawn provider-session process and handle streaming.
async fn spawn_provider_session_process(
    app: AppHandle,
    mut cmd: Command,
    prompt: String,
    model: String,
    project_path: String,
) -> Result<(), String> {
    use std::sync::Mutex;
    use tokio::io::{AsyncBufReadExt, BufReader};

    // Spawn the process
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn provider session process: {}", e))?;

    // Get stdout and stderr
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    // Get the child PID for logging
    let pid = child.id().unwrap_or(0);
    log::info!("Spawned provider session process with PID: {:?}", pid);

    // Create readers first (before moving child)
    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // We'll extract the session ID from init message
    let session_id_holder: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let run_id_holder: Arc<Mutex<Option<i64>>> = Arc::new(Mutex::new(None));

    // Store the child process in global state (for backward compatibility)
    let provider_session_state = app.state::<ProviderSessionProcessState>();
    {
        let mut current_process = provider_session_state.current_process.lock().await;
        // If there's already a process running, kill it first
        if let Some(mut existing_child) = current_process.take() {
            log::warn!("Killing existing provider session process before starting new one");
            let _ = existing_child.kill().await;
        }
        *current_process = Some(child);
    }

    // Spawn tasks to read stdout and stderr
    let app_handle = app.clone();
    let session_id_holder_clone = session_id_holder.clone();
    let run_id_holder_clone = run_id_holder.clone();
    let registry = app.state::<crate::process::ProcessRegistryState>();
    let registry_clone = registry.0.clone();
    let project_path_clone = project_path.clone();
    let prompt_clone = prompt.clone();
    let model_clone = model.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!("Provider session stdout: {}", &line[..line.len().min(200)]);

            // Parse the line to check for init message with session ID
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                if msg["type"] == "system" && msg["subtype"] == "init" {
                    if let Some(provider_session_id) = msg["session_id"].as_str() {
                        let mut session_id_guard = session_id_holder_clone.lock().unwrap();
                        if session_id_guard.is_none() {
                            *session_id_guard = Some(provider_session_id.to_string());
                            log::info!("Extracted provider session ID: {}", provider_session_id);

                            // Register with ProcessRegistry using provider session ID.
                            match registry_clone.register_provider_session(
                                provider_session_id.to_string(),
                                pid,
                                project_path_clone.clone(),
                                prompt_clone.clone(),
                                model_clone.clone(),
                            ) {
                                Ok(run_id) => {
                                    log::info!(
                                        "Registered provider session with run_id: {}",
                                        run_id
                                    );
                                    let mut run_id_guard = run_id_holder_clone.lock().unwrap();
                                    *run_id_guard = Some(run_id);
                                }
                                Err(e) => {
                                    log::error!("Failed to register provider session: {}", e);
                                }
                            }
                        }
                    }
                }
            }

            // Store live output in registry if we have a run_id
            if let Some(run_id) = *run_id_holder_clone.lock().unwrap() {
                let _ = registry_clone.append_live_output(run_id, &line);
            }

            // Emit the line to frontend with session isolation if we have session ID
            if let Some(ref session_id) = *session_id_holder_clone.lock().unwrap() {
                let _ = app_handle.emit(&format!("provider-session-output:{}", session_id), &line);
            }
            // Also emit generic event for compatibility
            let _ = app_handle.emit("provider-session-output", &line);
        }
    });

    let app_handle_stderr = app.clone();
    let session_id_holder_clone2 = session_id_holder.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::error!("Provider session stderr: {}", line);
            // Emit error lines with session isolation if we have session ID
            if let Some(ref session_id) = *session_id_holder_clone2.lock().unwrap() {
                let _ = app_handle_stderr.emit(&format!("provider-session-error:{}", session_id), &line);
            }
            // Also emit generic event for compatibility
            let _ = app_handle_stderr.emit("provider-session-error", &line);
        }
    });

    // Wait for process completion
    let app_handle_wait = app.clone();
    let provider_session_state_wait = provider_session_state.current_process.clone();
    let session_id_holder_clone3 = session_id_holder.clone();
    let run_id_holder_clone2 = run_id_holder.clone();
    let registry_clone2 = registry.0.clone();
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        // Get child from state to wait on it
        let mut current_process = provider_session_state_wait.lock().await;
        if let Some(mut child) = current_process.take() {
            match child.wait().await {
                Ok(status) => {
                    log::info!("Provider session process exited with status: {}", status);
                    let (completion_status, completion_error) = completion_status_from_exit_status(status);
                    // Small delay to ensure all messages are processed
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    if let Some(ref session_id) = *session_id_holder_clone3.lock().unwrap() {
                        let scoped_completion_payload = build_provider_session_completion_payload(
                            completion_status,
                            Some(session_id),
                            Some("claude"),
                            completion_error.as_deref(),
                        );
                        if completion_status == "cancelled" {
                            let _ = app_handle_wait
                                .emit(&format!("provider-session-cancelled:{}", session_id), true);
                        }
                        let _ = app_handle_wait.emit(
                            &format!("provider-session-complete:{}", session_id),
                            scoped_completion_payload,
                        );
                    }
                    if completion_status == "cancelled" {
                        let _ = app_handle_wait.emit("provider-session-cancelled", true);
                    }
                    // Also emit generic event for compatibility
                    let generic_completion_payload = build_provider_session_completion_payload(
                        completion_status,
                        session_id_holder_clone3
                            .lock()
                            .unwrap()
                            .as_deref(),
                        Some("claude"),
                        completion_error.as_deref(),
                    );
                    let _ = app_handle_wait.emit("provider-session-complete", generic_completion_payload);
                }
                Err(e) => {
                    log::error!("Failed to wait for provider session process: {}", e);
                    let error_message = format!("Failed to wait for provider session process: {}", e);
                    // Small delay to ensure all messages are processed
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    if let Some(ref session_id) = *session_id_holder_clone3.lock().unwrap() {
                        let scoped_completion_payload = build_provider_session_completion_payload(
                            "error",
                            Some(session_id),
                            Some("claude"),
                            Some(&error_message),
                        );
                        let _ = app_handle_wait
                            .emit(&format!("provider-session-complete:{}", session_id), scoped_completion_payload);
                    }
                    // Also emit generic event for compatibility
                    let generic_completion_payload = build_provider_session_completion_payload(
                        "error",
                        session_id_holder_clone3
                            .lock()
                            .unwrap()
                            .as_deref(),
                        Some("claude"),
                        Some(&error_message),
                    );
                    let _ = app_handle_wait.emit("provider-session-complete", generic_completion_payload);
                }
            }
        }

        // Unregister from ProcessRegistry if we have a run_id
        if let Some(run_id) = *run_id_holder_clone2.lock().unwrap() {
            let _ = registry_clone2.unregister_process(run_id);
        }

        // Clear process from state
        *current_process = None;
    });

    Ok(())
}
