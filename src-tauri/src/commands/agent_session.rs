use serde_json::json;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

use crate::providers::runtime::{
    self, ProviderCapability, ProviderCommandKind, ProviderCommandRequest, ProviderStreamAdapter,
};

#[tauri::command]
pub fn list_provider_capabilities() -> Result<Vec<ProviderCapability>, String> {
    Ok(runtime::list_provider_capabilities())
}

/// Execute a new session with any detected CLI agent.
///
/// For Claude, this delegates to provider-session runtime logic.
/// For other providers, command construction and stream behavior are delegated
/// to the provider runtime registry.
#[tauri::command]
pub async fn execute_agent_session(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    prompt: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    run_agent_session(
        app,
        provider_id,
        project_path,
        None,
        prompt,
        model,
        reasoning_effort,
        ProviderCommandKind::Execute,
    )
    .await
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
    run_agent_session(
        app,
        provider_id,
        project_path,
        None,
        prompt,
        model,
        reasoning_effort,
        ProviderCommandKind::Continue,
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
    run_agent_session(
        app,
        provider_id,
        project_path,
        Some(session_id),
        prompt,
        model,
        reasoning_effort,
        ProviderCommandKind::Resume,
    )
    .await
}

async fn run_agent_session(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    session_id: Option<String>,
    prompt: String,
    model: String,
    reasoning_effort: Option<String>,
    requested_kind: ProviderCommandKind,
) -> Result<(), String> {
    tracing::info!(
        "Starting agent session: provider={}, kind={:?}, project={}, model={}",
        provider_id,
        requested_kind,
        project_path,
        model
    );

    if provider_id == "claude" {
        return match requested_kind {
            ProviderCommandKind::Execute => {
                crate::commands::provider_session::execute_provider_session(
                    app,
                    project_path,
                    prompt,
                    model,
                )
                .await
            }
            ProviderCommandKind::Continue => {
                crate::commands::provider_session::continue_provider_session(
                    app,
                    project_path,
                    prompt,
                    model,
                )
                .await
            }
            ProviderCommandKind::Resume => {
                let resume_session_id = session_id.unwrap_or_default();
                crate::commands::provider_session::resume_provider_session(
                    app,
                    project_path,
                    resume_session_id,
                    prompt,
                    model,
                )
                .await
            }
        };
    }

    run_non_claude_provider_session(
        app,
        provider_id,
        project_path,
        session_id,
        prompt,
        model,
        reasoning_effort,
        requested_kind,
    )
    .await
}

async fn run_non_claude_provider_session(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    session_id: Option<String>,
    prompt: String,
    model: String,
    reasoning_effort: Option<String>,
    requested_kind: ProviderCommandKind,
) -> Result<(), String> {
    let runtime = runtime::get_provider_runtime(&provider_id)
        .ok_or_else(|| format!("Provider '{}' is not registered", provider_id))?;

    let effective_kind = match requested_kind {
        ProviderCommandKind::Continue if !runtime.capabilities.supports_continue => {
            tracing::warn!(
                "Provider '{}' does not support continue; falling back to execute",
                provider_id
            );
            ProviderCommandKind::Execute
        }
        ProviderCommandKind::Resume if !runtime.capabilities.supports_resume => {
            tracing::warn!(
                "Provider '{}' does not support resume; falling back to execute",
                provider_id
            );
            ProviderCommandKind::Execute
        }
        _ => requested_kind,
    };

    let agent = crate::agent_binary::discover_agent(&app, &provider_id)
        .await
        .ok_or_else(|| format!("Provider '{}' not found on system", provider_id))?;

    let request = ProviderCommandRequest {
        kind: effective_kind,
        prompt: prompt.clone(),
        model: model.clone(),
        session_id,
        reasoning_effort,
    };

    let args = (runtime.build_args)(&request)?;
    let cmd = create_agent_command(&agent.binary_path, args, &project_path);

    spawn_agent_process(
        app,
        cmd,
        provider_id,
        prompt,
        model,
        project_path,
        runtime.stream_adapter,
    )
    .await
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

fn completion_status_from_exit_status(
    exit_status: std::process::ExitStatus,
) -> (&'static str, Option<String>) {
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
/// Inherits all environment variables and uses piped stdio.
fn create_agent_command(binary_path: &str, args: Vec<String>, project_path: &str) -> Command {
    let mut cmd = Command::new(binary_path);

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

fn wrap_text_as_assistant(line: &str) -> String {
    serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": line}]
        }
    })
    .to_string()
}

fn normalize_stream_line(line: &str, stream_adapter: ProviderStreamAdapter) -> Option<String> {
    match stream_adapter {
        ProviderStreamAdapter::CodexJson => crate::commands::codex_transform::transform_codex_line(line),
        ProviderStreamAdapter::ClaudeJson | ProviderStreamAdapter::TextWrapped => {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                let has_type = parsed.get("type").and_then(|value| value.as_str()).is_some();
                let has_message_content = parsed
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .is_some();
                if has_type && has_message_content {
                    Some(line.to_string())
                } else {
                    Some(wrap_text_as_assistant(line))
                }
            } else {
                Some(wrap_text_as_assistant(line))
            }
        }
    }
}

/// Spawn a non-Claude agent process and stream output via provider-session events.
async fn spawn_agent_process(
    app: AppHandle,
    mut cmd: Command,
    provider_id: String,
    prompt: String,
    model: String,
    project_path: String,
    stream_adapter: ProviderStreamAdapter,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Failed to spawn {}: {}", provider_id, error))?;

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    let pid = child.id().unwrap_or(0);
    tracing::info!("Spawned {} process with PID: {}", provider_id, pid);

    let run_id = format!(
        "{}_{}_{}",
        provider_id,
        pid,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

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
            tracing::info!("Registered {} session with registry id: {}", provider_id, rid);
            Some(rid)
        }
        Err(error) => {
            tracing::error!("Failed to register {} session: {}", provider_id, error);
            None
        }
    };

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

    let app_stdout = app.clone();
    let run_id_stdout = run_id.clone();
    let registry_stdout = registry_clone.clone();
    let reg_id_stdout = reg_id;
    let provider_stdout = provider_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(
                "{} stdout ({}): {}",
                run_id_stdout,
                provider_stdout,
                &line[..line.len().min(200)]
            );

            if let Some(rid) = reg_id_stdout {
                let _ = registry_stdout.append_live_output(rid, &line);
            }

            let wrapped = normalize_stream_line(&line, stream_adapter);
            if let Some(ref wrapped_line) = wrapped {
                let _ = app_stdout.emit(
                    &format!("provider-session-output:{}", run_id_stdout),
                    wrapped_line,
                );
                let _ = app_stdout.emit("provider-session-output", wrapped_line);
            }
        }
    });

    let app_stderr = app.clone();
    let run_id_stderr = run_id.clone();
    let registry_stderr = registry_clone.clone();
    let reg_id_stderr = reg_id;
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rid) = reg_id_stderr {
                let _ = registry_stderr.append_live_output(rid, &line);
            }

            let _ = app_stderr.emit(&format!("provider-session-error:{}", run_id_stderr), &line);
            let _ = app_stderr.emit("provider-session-error", &line);
        }
    });

    let app_wait = app.clone();
    let run_id_wait = run_id.clone();
    let provider_id_wait = provider_id.clone();
    let registry_wait = registry_clone;
    let reg_id_wait = reg_id;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        match child.wait().await {
            Ok(status) => {
                let (completion_status, completion_error) = completion_status_from_exit_status(status);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

                if completion_status == "cancelled" {
                    let _ = app_wait.emit(&format!("provider-session-cancelled:{}", run_id_wait), true);
                    let _ = app_wait.emit("provider-session-cancelled", true);
                }

                let scoped_completion_payload = build_agent_completion_payload(
                    completion_status,
                    Some(&run_id_wait),
                    Some(&provider_id_wait),
                    completion_error.as_deref(),
                );
                let generic_completion_payload = build_agent_completion_payload(
                    completion_status,
                    Some(&run_id_wait),
                    Some(&provider_id_wait),
                    completion_error.as_deref(),
                );
                let _ = app_wait.emit(
                    &format!("provider-session-complete:{}", run_id_wait),
                    scoped_completion_payload,
                );
                let _ = app_wait.emit("provider-session-complete", generic_completion_payload);
            }
            Err(error) => {
                let error_message = format!("Failed to wait for {} process: {}", run_id_wait, error);
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                let scoped_completion_payload = build_agent_completion_payload(
                    "error",
                    Some(&run_id_wait),
                    Some(&provider_id_wait),
                    Some(&error_message),
                );
                let generic_completion_payload = build_agent_completion_payload(
                    "error",
                    Some(&run_id_wait),
                    Some(&provider_id_wait),
                    Some(&error_message),
                );
                let _ = app_wait.emit(
                    &format!("provider-session-complete:{}", run_id_wait),
                    scoped_completion_payload,
                );
                let _ = app_wait.emit("provider-session-complete", generic_completion_payload);
            }
        }

        if let Some(rid) = reg_id_wait {
            let _ = registry_wait.unregister_process(rid);
        }
    });

    Ok(())
}
