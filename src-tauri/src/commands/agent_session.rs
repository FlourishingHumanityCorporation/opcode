use std::process::Stdio;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

/// Execute a new session with any detected CLI agent.
///
/// For Claude, this delegates to the existing provider-session runtime logic.
/// For other providers, it spawns the binary with appropriate args and
/// streams raw output via Tauri events.
#[tauri::command]
pub async fn execute_agent_session(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    prompt: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    log::info!(
        "Starting agent session: provider={}, project={}, model={}",
        provider_id,
        project_path,
        model
    );

    if provider_id == "claude" {
        // Delegate to existing provider-session execution (preserves Claude behavior)
        return crate::commands::provider_session::execute_provider_session(
            app,
            project_path,
            prompt,
            model,
        )
        .await;
    }

    // For non-Claude providers: find binary and spawn with generic streaming
    let agents = crate::agent_binary::discover_all_agents(&app).await;
    let agent = agents
        .iter()
        .find(|a| a.provider_id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found on system", provider_id))?;

    let binary_path = agent.binary_path.clone();

    // Build args based on provider conventions
    let args = build_provider_args(&provider_id, &prompt, &model, reasoning_effort.as_deref());

    let cmd = create_agent_command(&binary_path, args, &project_path);
    spawn_agent_process(app, cmd, provider_id, prompt, model, project_path).await
}

/// Continue an existing session (provider-aware).
#[tauri::command]
pub async fn continue_agent_session(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    prompt: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    if provider_id == "claude" {
        return crate::commands::provider_session::continue_provider_session(
            app,
            project_path,
            prompt,
            model,
        )
        .await;
    }

    // Non-Claude providers: just execute again (most don't have "continue" concept)
    execute_agent_session(
        app,
        provider_id,
        project_path,
        prompt,
        model,
        reasoning_effort,
    )
    .await
}

/// Resume an existing session (provider-aware).
#[tauri::command]
pub async fn resume_agent_session(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    session_id: String,
    prompt: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    if provider_id == "claude" {
        return crate::commands::provider_session::resume_provider_session(
            app,
            project_path,
            session_id,
            prompt,
            model,
        )
        .await;
    }

    // Non-Claude providers: resume not supported, start new session
    log::warn!(
        "Provider '{}' does not support session resume, starting new session",
        provider_id
    );
    execute_agent_session(
        app,
        provider_id,
        project_path,
        prompt,
        model,
        reasoning_effort,
    )
    .await
}

/// Build CLI arguments based on provider conventions.
/// Each provider has different flags for non-interactive execution.
fn build_provider_args(
    provider_id: &str,
    prompt: &str,
    model: &str,
    reasoning_effort: Option<&str>,
) -> Vec<String> {
    match provider_id {
        "codex" => {
            // Use `exec --json` for structured JSONL output (transformed in codex_transform.rs)
            let mut args = vec!["exec".to_string(), "--json".to_string(), prompt.to_string()];
            // Only pass --model if it's not a Claude model name (codex uses OpenAI models)
            let claude_models = ["default", "sonnet", "opus", "haiku", "claude"];
            if !model.is_empty()
                && !claude_models.iter().any(|m| model.to_lowercase().contains(m))
            {
                args.extend_from_slice(&["--model".to_string(), model.to_string()]);
            }
            if let Some(effort) = sanitize_reasoning_effort(reasoning_effort) {
                args.extend([
                    "-c".to_string(),
                    format!("model_reasoning_effort=\"{}\"", effort),
                ]);
            } else if reasoning_effort.is_some() {
                log::warn!("Ignoring invalid codex reasoning effort: {:?}", reasoning_effort);
            }
            args
        }
        "gemini" => {
            let mut args = vec![
                "--prompt".to_string(),
                prompt.to_string(),
                "--approval-mode".to_string(),
                "yolo".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if !model.is_empty() {
                args.extend_from_slice(&["--model".to_string(), model.to_string()]);
            }
            args
        }
        "aider" => {
            let mut args = vec![
                "--message".to_string(),
                prompt.to_string(),
                "--yes".to_string(), // auto-approve to avoid TTY prompts
            ];
            if !model.is_empty() {
                args.extend_from_slice(&["--model".to_string(), model.to_string()]);
            }
            args
        }
        "goose" => {
            let mut args = vec![
                "run".to_string(),
                "--text".to_string(),
                prompt.to_string(),
                "--no-session".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if !model.is_empty() {
                args.extend_from_slice(&["--model".to_string(), model.to_string()]);
            }
            args
        }
        "opencode" => {
            let mut args = vec!["run".to_string(), prompt.to_string()];
            if !model.is_empty() {
                args.extend_from_slice(&["--model".to_string(), model.to_string()]);
            }
            args
        }
        _ => {
            // Generic: just pass prompt as first arg
            vec![prompt.to_string()]
        }
    }
}

fn sanitize_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&'static str> {
    match reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
    {
        Some(value) => match value.as_str() {
            "none" => Some("none"),
            "minimal" => Some("minimal"),
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "xhigh" => Some("xhigh"),
            _ => None,
        },
        None => None,
    }
}

fn build_agent_completion_payload(
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
            "Agent process exited with status: {}",
            exit_status
        )),
    )
}

/// Create a tokio Command for a non-Claude agent.
/// Inherits ALL environment variables (fixes Issue #400 for non-Claude providers).
/// Uses Stdio::null() for stdin since prompts are passed as args, not via stdin.
fn create_agent_command(binary_path: &str, args: Vec<String>, project_path: &str) -> Command {
    let mut cmd = Command::new(binary_path);

    // Inherit full environment (no whitelist filtering)
    for (key, value) in std::env::vars() {
        cmd.env(&key, &value);
    }

    for arg in args {
        cmd.arg(arg);
    }

    cmd.current_dir(project_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd
}

/// Spawn a non-Claude agent process and stream output via provider-session events.
async fn spawn_agent_process(
    app: AppHandle,
    mut cmd: Command,
    provider_id: String,
    prompt: String,
    model: String,
    project_path: String,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", provider_id, e))?;

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    let pid = child.id().unwrap_or(0);
    log::info!("Spawned {} process with PID: {}", provider_id, pid);

    // Generate a unique run ID for this session
    let run_id = format!(
        "{}_{}_{}",
        provider_id,
        pid,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    // Register with process registry
    let registry = app.state::<crate::process::ProcessRegistryState>();
    let registry_clone = registry.0.clone();
    let reg_id: Option<i64> = match registry.0.register_provider_session(
        run_id.clone(),
        pid,
        project_path.clone(),
        prompt.clone(),
        model.clone(),
    ) {
        Ok(rid) => {
            log::info!("Registered {} session with registry id: {}", provider_id, rid);
            Some(rid)
        }
        Err(e) => {
            log::error!("Failed to register {} session: {}", provider_id, e);
            None
        }
    };

    // Also emit a system:init-like event so the frontend can track this session
    let init_msg = serde_json::json!({
        "type": "system",
        "subtype": "init",
        "session_id": run_id,
        "provider_id": provider_id,
    });
    let _ = app.emit("provider-session-output", &init_msg.to_string());
    let _ = app.emit(
        &format!("provider-session-output:{}", run_id),
        &init_msg.to_string(),
    );

    // Stream stdout — provider-aware transformation to Claude-compatible JSON
    let app_stdout = app.clone();
    let run_id_stdout = run_id.clone();
    let registry_stdout = registry_clone.clone();
    let reg_id_stdout = reg_id;
    let provider_stdout = provider_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!(
                "{} stdout ({}): {}",
                run_id_stdout,
                provider_stdout,
                &line[..line.len().min(200)]
            );

            // Store live output
            if let Some(rid) = reg_id_stdout {
                let _ = registry_stdout.append_live_output(rid, &line);
            }

            // Provider-aware transformation
            let wrapped = match provider_stdout.as_str() {
                "codex" => {
                    // Use structured transformer for codex --json JSONL output
                    let result = crate::commands::codex_transform::transform_codex_line(&line);
                    if result.is_none() {
                        log::debug!("{} codex line skipped (no renderable content)", run_id_stdout);
                    }
                    result
                }
                _ => {
                    // Generic: wrap unknown JSON/text unless already Claude-compatible.
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                        let has_type = parsed.get("type").and_then(|v| v.as_str()).is_some();
                        let has_message_content = parsed
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .is_some();
                        if has_type && has_message_content {
                            Some(line.clone())
                        } else {
                            Some(
                                serde_json::json!({
                                    "type": "assistant",
                                    "message": {
                                        "content": [{"type": "text", "text": line}]
                                    }
                                })
                                .to_string(),
                            )
                        }
                    } else {
                        Some(
                            serde_json::json!({
                                "type": "assistant",
                                "message": {
                                    "content": [{"type": "text", "text": line}]
                                }
                            })
                            .to_string(),
                        )
                    }
                }
            };

            if let Some(ref w) = wrapped {
                log::info!(
                    "{} emitting provider-session-output: {}",
                    run_id_stdout,
                    &w[..w.len().min(200)]
                );
                let _ = app_stdout.emit(&format!("provider-session-output:{}", run_id_stdout), w);
                let _ = app_stdout.emit("provider-session-output", w);
            }
        }
    });

    // Stream stderr on provider-session-error channel for parity with web mode.
    let app_stderr = app.clone();
    let run_id_stderr = run_id.clone();
    let registry_stderr = registry_clone.clone();
    let reg_id_stderr = reg_id;
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!("{} stderr: {}", run_id_stderr, line);

            // Store live output
            if let Some(rid) = reg_id_stderr {
                let _ = registry_stderr.append_live_output(rid, &line);
            }

            let _ = app_stderr.emit(&format!("provider-session-error:{}", run_id_stderr), &line);
            let _ = app_stderr.emit("provider-session-error", &line);
        }
    });

    // Wait for completion
    let app_wait = app.clone();
    let run_id_wait = run_id.clone();
    let registry_wait = registry_clone;
    let reg_id_wait = reg_id;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        match child.wait().await {
            Ok(status) => {
                log::info!("{} process exited with status: {}", run_id_wait, status);
                let (completion_status, completion_error) = completion_status_from_exit_status(status);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                if completion_status == "cancelled" {
                    let _ = app_wait.emit(&format!("provider-session-cancelled:{}", run_id_wait), true);
                    let _ = app_wait.emit("provider-session-cancelled", true);
                }
                let scoped_completion_payload = build_agent_completion_payload(
                    completion_status,
                    Some(&run_id_wait),
                    Some(&provider_id),
                    completion_error.as_deref(),
                );
                let generic_completion_payload = build_agent_completion_payload(
                    completion_status,
                    Some(&run_id_wait),
                    Some(&provider_id),
                    completion_error.as_deref(),
                );
                let _ = app_wait.emit(
                    &format!("provider-session-complete:{}", run_id_wait),
                    scoped_completion_payload,
                );
                let _ = app_wait.emit("provider-session-complete", generic_completion_payload);
            }
            Err(e) => {
                log::error!("Failed to wait for {} process: {}", run_id_wait, e);
                let error_message = format!("Failed to wait for {} process: {}", run_id_wait, e);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                let scoped_completion_payload = build_agent_completion_payload(
                    "error",
                    Some(&run_id_wait),
                    Some(&provider_id),
                    Some(&error_message),
                );
                let generic_completion_payload = build_agent_completion_payload(
                    "error",
                    Some(&run_id_wait),
                    Some(&provider_id),
                    Some(&error_message),
                );
                let _ = app_wait.emit(
                    &format!("provider-session-complete:{}", run_id_wait),
                    scoped_completion_payload,
                );
                let _ = app_wait.emit("provider-session-complete", generic_completion_payload);
            }
        }

        // Unregister from process registry
        if let Some(rid) = reg_id_wait {
            let _ = registry_wait.unregister_process(rid);
        }
    });

    Ok(())
}
