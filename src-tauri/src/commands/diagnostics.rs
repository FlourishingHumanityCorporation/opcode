use crate::claude_binary::find_claude_binary;
use serde::Serialize;
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeBenchmarkKind {
    Startup,
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStartupProbeResult {
    pub benchmark_kind: ProbeBenchmarkKind,
    pub provider_id: String,
    pub project_path: String,
    pub model: String,
    pub timeout_ms: u64,
    pub timed_out: bool,
    pub total_ms: u64,
    pub first_stdout_ms: Option<u64>,
    pub first_stderr_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
    pub first_json_event_ms: Option<u64>,
    pub first_assistant_message_ms: Option<u64>,
    pub first_result_message_ms: Option<u64>,
    pub stdout_json_lines: u64,
    pub stdout_parse_errors: u64,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug)]
struct StdoutProbeMetrics {
    bytes: usize,
    first_byte_ms: Option<u64>,
    first_json_event_ms: Option<u64>,
    first_assistant_message_ms: Option<u64>,
    first_result_message_ms: Option<u64>,
    json_line_count: u64,
    parse_error_count: u64,
}

fn apply_json_line_metrics(
    line: &str,
    now_ms: u64,
    first_json_event_ms: &mut Option<u64>,
    first_assistant_message_ms: &mut Option<u64>,
    first_result_message_ms: &mut Option<u64>,
    json_line_count: &mut u64,
    parse_error_count: &mut u64,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) => {
            *json_line_count += 1;
            if first_json_event_ms.is_none() {
                *first_json_event_ms = Some(now_ms);
            }
            if let Some(event_type) = value.get("type").and_then(|item| item.as_str()) {
                if event_type == "assistant" && first_assistant_message_ms.is_none() {
                    *first_assistant_message_ms = Some(now_ms);
                } else if event_type == "result" && first_result_message_ms.is_none() {
                    *first_result_message_ms = Some(now_ms);
                }
            }
        }
        Err(_) => {
            *parse_error_count += 1;
        }
    }
}

async fn read_stdout_probe_metrics<T>(
    mut stream: T,
    started_at: Instant,
) -> Result<StdoutProbeMetrics, String>
where
    T: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut bytes: usize = 0;
    let mut first_byte_ms: Option<u64> = None;
    let mut first_json_event_ms: Option<u64> = None;
    let mut first_assistant_message_ms: Option<u64> = None;
    let mut first_result_message_ms: Option<u64> = None;
    let mut json_line_count: u64 = 0;
    let mut parse_error_count: u64 = 0;
    let mut buffer = [0u8; 8192];
    let mut carry = String::new();

    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read stdout stream: {}", e))?;
        if read == 0 {
            break;
        }
        bytes += read;
        let now_ms = started_at.elapsed().as_millis() as u64;
        if first_byte_ms.is_none() {
            first_byte_ms = Some(now_ms);
        }

        carry.push_str(&String::from_utf8_lossy(&buffer[..read]));
        while let Some(newline_index) = carry.find('\n') {
            let line = carry[..newline_index].to_string();
            carry.drain(..=newline_index);
            apply_json_line_metrics(
                &line,
                now_ms,
                &mut first_json_event_ms,
                &mut first_assistant_message_ms,
                &mut first_result_message_ms,
                &mut json_line_count,
                &mut parse_error_count,
            );
        }
    }

    if !carry.trim().is_empty() {
        let now_ms = started_at.elapsed().as_millis() as u64;
        apply_json_line_metrics(
            &carry,
            now_ms,
            &mut first_json_event_ms,
            &mut first_assistant_message_ms,
            &mut first_result_message_ms,
            &mut json_line_count,
            &mut parse_error_count,
        );
    }

    Ok(StdoutProbeMetrics {
        bytes,
        first_byte_ms,
        first_json_event_ms,
        first_assistant_message_ms,
        first_result_message_ms,
        json_line_count,
        parse_error_count,
    })
}

async fn read_stderr_probe_metrics<T>(mut stream: T, started_at: Instant) -> Result<(usize, Option<u64>), String>
where
    T: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut bytes: usize = 0;
    let mut first_byte_ms: Option<u64> = None;
    let mut buffer = [0u8; 4096];

    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read stderr stream: {}", e))?;
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
    benchmark_kind: Option<String>,
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
    let benchmark_kind = match benchmark_kind.as_deref() {
        Some("assistant") => ProbeBenchmarkKind::Assistant,
        _ => ProbeBenchmarkKind::Startup,
    };

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

    let stdout_task = tokio::spawn(read_stdout_probe_metrics(stdout, started_at));
    let stderr_task = tokio::spawn(read_stderr_probe_metrics(stderr, started_at));

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

    let stdout_metrics = stdout_task
        .await
        .map_err(|e| format!("Failed to join stdout task: {}", e))??;
    let (stderr_bytes, first_stderr_ms) = stderr_task
        .await
        .map_err(|e| format!("Failed to join stderr task: {}", e))??;

    let stdout_bytes = stdout_metrics.bytes;
    let first_stdout_ms = stdout_metrics.first_byte_ms;

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
        benchmark_kind,
        provider_id: "claude".to_string(),
        project_path,
        model,
        timeout_ms,
        timed_out,
        total_ms: started_at.elapsed().as_millis() as u64,
        first_stdout_ms,
        first_stderr_ms,
        first_byte_ms,
        first_json_event_ms: stdout_metrics.first_json_event_ms,
        first_assistant_message_ms: stdout_metrics.first_assistant_message_ms,
        first_result_message_ms: stdout_metrics.first_result_message_ms,
        stdout_json_lines: stdout_metrics.json_line_count,
        stdout_parse_errors: stdout_metrics.parse_error_count,
        stdout_bytes,
        stderr_bytes,
        exit_code: exit_status.as_ref().and_then(|status| status.code()),
        signal,
    })
}
