use crate::claude_binary::find_claude_binary;
use serde::Serialize;
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize)]
pub struct SessionStartupProbeResult {
    pub provider_id: String,
    pub project_path: String,
    pub model: String,
    pub timeout_ms: u64,
    pub timed_out: bool,
    pub total_ms: u64,
    pub first_stdout_ms: Option<u64>,
    pub first_stderr_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

async fn read_stream_first_byte<T>(mut stream: T, started_at: Instant) -> Result<(usize, Option<u64>), String>
where
    T: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut bytes: usize = 0;
    let mut first_byte_ms: Option<u64> = None;
    let mut buffer = [0u8; 8192];

    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read process stream: {}", e))?;
        if read == 0 {
            break;
        }
        bytes += read;
        if first_byte_ms.is_none() {
            first_byte_ms = Some(started_at.elapsed().as_millis() as u64);
        }
    }

    Ok((bytes, first_byte_ms))
}

#[tauri::command]
pub async fn run_session_startup_probe(
    app: AppHandle,
    project_path: String,
    model: Option<String>,
    prompt: Option<String>,
    timeout_ms: Option<u64>,
    include_partial_messages: Option<bool>,
) -> Result<SessionStartupProbeResult, String> {
    let path = std::path::PathBuf::from(&project_path);
    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    if !path.is_dir() {
        return Err(format!("Project path is not a directory: {}", project_path));
    }

    let model = model
        .unwrap_or_else(|| "sonnet".to_string())
        .trim()
        .to_string();
    let prompt = prompt
        .unwrap_or_else(|| "Reply with exactly OK and nothing else.".to_string())
        .trim()
        .to_string();
    let timeout_ms = timeout_ms.unwrap_or(45_000).clamp(1_000, 300_000);
    let include_partial_messages = include_partial_messages.unwrap_or(false);

    let claude_path = find_claude_binary(&app)?;

    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    if include_partial_messages {
        args.push("--include-partial-messages".to_string());
    }

    let mut command = Command::new(&claude_path);
    command
        .args(args)
        .current_dir(&project_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let started_at = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude process: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to attach stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to attach stderr pipe".to_string())?;

    let stdout_task = tokio::spawn(read_stream_first_byte(stdout, started_at));
    let stderr_task = tokio::spawn(read_stream_first_byte(stderr, started_at));

    let mut timed_out = false;
    let exit_status = match timeout(Duration::from_millis(timeout_ms), child.wait()).await {
        Ok(wait_result) => Some(
            wait_result.map_err(|e| format!("Failed while waiting for Claude process: {}", e))?,
        ),
        Err(_) => {
            timed_out = true;
            let _ = child.kill().await;
            child.wait().await.ok()
        }
    };

    let (stdout_bytes, first_stdout_ms) = stdout_task
        .await
        .map_err(|e| format!("Failed to join stdout task: {}", e))??;
    let (stderr_bytes, first_stderr_ms) = stderr_task
        .await
        .map_err(|e| format!("Failed to join stderr task: {}", e))??;

    let first_byte_ms = match (first_stdout_ms, first_stderr_ms) {
        (Some(out), Some(err)) => Some(out.min(err)),
        (Some(out), None) => Some(out),
        (None, Some(err)) => Some(err),
        (None, None) => None,
    };

    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        exit_status.as_ref().and_then(|status| status.signal())
    };
    #[cfg(not(unix))]
    let signal = None;

    Ok(SessionStartupProbeResult {
        provider_id: "claude".to_string(),
        project_path,
        model,
        timeout_ms,
        timed_out,
        total_ms: started_at.elapsed().as_millis() as u64,
        first_stdout_ms,
        first_stderr_ms,
        first_byte_ms,
        stdout_bytes,
        stderr_bytes,
        exit_code: exit_status.as_ref().and_then(|status| status.code()),
        signal,
    })
}
