use crate::claude_binary::find_claude_binary;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{sleep, timeout, Duration};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeBenchmarkKind {
    Startup,
    Assistant,
    AssistantIterm,
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn applescript_quote(value: &str) -> String {
    value.replace('\\', r#"\\"#).replace('"', r#"\""#)
}

#[cfg(target_os = "macos")]
async fn run_osascript_lines(lines: Vec<String>) -> Result<(), String> {
    let mut command = Command::new("osascript");
    for line in lines {
        command.arg("-e").arg(line);
    }

    let output = command
        .output()
        .await
        .map_err(|e| format!("Failed to execute osascript: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(format!(
        "AppleScript command failed (stdout: {}, stderr: {})",
        stdout, stderr
    ))
}

fn build_probe_args(prompt: &str, model: &str, include_partial_messages: bool) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--model".to_string(),
        model.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    if include_partial_messages {
        args.push("--include-partial-messages".to_string());
    }

    args
}

fn consume_stdout_chunk(
    chunk: &str,
    now_ms: u64,
    carry: &mut String,
    first_json_event_ms: &mut Option<u64>,
    first_assistant_message_ms: &mut Option<u64>,
    first_result_message_ms: &mut Option<u64>,
    json_line_count: &mut u64,
    parse_error_count: &mut u64,
) {
    carry.push_str(chunk);
    while let Some(newline_index) = carry.find('\n') {
        let line = carry[..newline_index].to_string();
        carry.drain(..=newline_index);
        apply_json_line_metrics(
            &line,
            now_ms,
            first_json_event_ms,
            first_assistant_message_ms,
            first_result_message_ms,
            json_line_count,
            parse_error_count,
        );
    }
}

fn parse_which_output(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let first_line = trimmed.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return None;
    }
    if first_line.starts_with("claude:") && first_line.contains("aliased to") {
        return first_line
            .split("aliased to")
            .nth(1)
            .map(|value| value.trim().to_string());
    }
    Some(first_line.to_string())
}

fn select_iterm_probe_binary(
    which_candidate: Option<String>,
    discovered_fallback: Option<String>,
) -> Result<String, String> {
    if let Some(candidate_raw) = which_candidate {
        let candidate = candidate_raw.trim().to_string();
        if !candidate.is_empty() && !crate::claude_binary::is_disallowed_claude_path(&candidate) {
            if candidate == "claude" || (PathBuf::from(&candidate).exists() && PathBuf::from(&candidate).is_file())
            {
                return Ok(candidate);
            }
        }
    }

    if let Some(discovered) = discovered_fallback {
        if crate::claude_binary::is_disallowed_claude_path(&discovered) {
            return Err(
                "Resolved Claude path points to a GUI app bundle. Please configure a CLI binary."
                    .to_string(),
            );
        }
        return Ok(discovered);
    }

    Err("Failed to resolve Claude CLI binary for iTerm benchmark.".to_string())
}

fn resolve_iterm_probe_binary(app: &AppHandle) -> Result<String, String> {
    let which_candidate = if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_which_output(&stdout)
        } else {
            None
        }
    } else {
        None
    };

    if let Ok(selected) = select_iterm_probe_binary(which_candidate.clone(), None) {
        return Ok(selected);
    }

    let discovered = find_claude_binary(app)?;
    select_iterm_probe_binary(which_candidate, Some(discovered))
}

async fn run_direct_probe(
    benchmark_kind: ProbeBenchmarkKind,
    project_path: String,
    model: String,
    timeout_ms: u64,
    claude_path: String,
    args: Vec<String>,
) -> Result<SessionStartupProbeResult, String> {
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

#[cfg(target_os = "macos")]
async fn launch_iterm_script(script_path: &Path) -> Result<(), String> {
    let script_literal = applescript_quote(&script_path.to_string_lossy());
    let script_lines = vec![
        format!(r#"set scriptPath to "{}""#, script_literal),
        r#"set benchmarkCommand to "bash " & quoted form of scriptPath"#.to_string(),
        r#"tell application "iTerm""#.to_string(),
        r#"  activate"#.to_string(),
        r#"  if (count of windows) = 0 then"#.to_string(),
        r#"    create window with default profile"#.to_string(),
        r#"  end if"#.to_string(),
        r#"  tell current session of current window"#.to_string(),
        r#"    write text benchmarkCommand"#.to_string(),
        r#"  end tell"#.to_string(),
        r#"end tell"#.to_string(),
    ];

    run_osascript_lines(script_lines)
        .await
        .map_err(|err| format!("Failed to launch iTerm benchmark command: {}", err))
}

#[cfg(target_os = "macos")]
async fn terminate_pid_from_file(pid_path: &Path) {
    let pid_text = match tokio::fs::read_to_string(pid_path).await {
        Ok(value) => value,
        Err(_) => return,
    };
    let pid = match pid_text.trim().parse::<i32>() {
        Ok(value) if value > 0 => value,
        _ => return,
    };

    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .await;
    sleep(Duration::from_millis(200)).await;
    let _ = Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status()
        .await;
}

#[cfg(target_os = "macos")]
async fn run_iterm_probe(
    project_path: String,
    model: String,
    timeout_ms: u64,
    claude_path: String,
    args: Vec<String>,
) -> Result<SessionStartupProbeResult, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let probe_dir = std::env::temp_dir().join(format!("opcode-iterm-benchmark-{}-{}", std::process::id(), nonce));
    std::fs::create_dir_all(&probe_dir)
        .map_err(|e| format!("Failed to create iTerm benchmark temp directory: {}", e))?;

    let stdout_path = probe_dir.join("stdout.jsonl");
    let stderr_path = probe_dir.join("stderr.log");
    let status_path = probe_dir.join("exit.code");
    let pid_path = probe_dir.join("pid");
    let script_path = probe_dir.join("run-probe.sh");

    let quoted_args = args
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let command_line = format!("{} {}", shell_quote(&claude_path), quoted_args);

    let script = format!(
        r#"#!/bin/bash
cd {project_dir} || {{ echo 200 > {status_file}; exit 0; }}
{command_line} > {stdout_file} 2> {stderr_file} &
child_pid=$!
echo "$child_pid" > {pid_file}
wait "$child_pid"
echo "$?" > {status_file}
"#,
        project_dir = shell_quote(&project_path),
        command_line = command_line,
        stdout_file = shell_quote(&stdout_path.to_string_lossy()),
        stderr_file = shell_quote(&stderr_path.to_string_lossy()),
        pid_file = shell_quote(&pid_path.to_string_lossy()),
        status_file = shell_quote(&status_path.to_string_lossy()),
    );

    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write iTerm benchmark script: {}", e))?;

    launch_iterm_script(&script_path).await?;

    let started_at = Instant::now();
    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;

    let mut first_stdout_ms: Option<u64> = None;
    let mut first_stderr_ms: Option<u64> = None;
    let mut first_json_event_ms: Option<u64> = None;
    let mut first_assistant_message_ms: Option<u64> = None;
    let mut first_result_message_ms: Option<u64> = None;
    let mut stdout_json_lines: u64 = 0;
    let mut stdout_parse_errors: u64 = 0;
    let mut stdout_bytes: usize = 0;
    let mut stdout_carry = String::new();

    loop {
        let now_ms = started_at.elapsed().as_millis() as u64;

        let stdout_data = tokio::fs::read(&stdout_path).await.unwrap_or_default();
        if first_stdout_ms.is_none() && !stdout_data.is_empty() {
            first_stdout_ms = Some(now_ms);
        }
        if stdout_data.len() > stdout_bytes {
            let new_chunk = String::from_utf8_lossy(&stdout_data[stdout_bytes..]);
            consume_stdout_chunk(
                &new_chunk,
                now_ms,
                &mut stdout_carry,
                &mut first_json_event_ms,
                &mut first_assistant_message_ms,
                &mut first_result_message_ms,
                &mut stdout_json_lines,
                &mut stdout_parse_errors,
            );
            stdout_bytes = stdout_data.len();
        } else {
            stdout_bytes = stdout_data.len();
        }

        let stderr_data = tokio::fs::read(&stderr_path).await.unwrap_or_default();
        let stderr_len = stderr_data.len();
        if first_stderr_ms.is_none() && stderr_len > 0 {
            first_stderr_ms = Some(now_ms);
        }

        if let Ok(status_raw) = tokio::fs::read_to_string(&status_path).await {
            exit_code = status_raw
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<i32>().ok());
            break;
        }

        if now_ms >= timeout_ms {
            timed_out = true;
            break;
        }

        sleep(Duration::from_millis(100)).await;
    }

    if timed_out {
        terminate_pid_from_file(&pid_path).await;
    }

    if !stdout_carry.trim().is_empty() {
        apply_json_line_metrics(
            &stdout_carry,
            started_at.elapsed().as_millis() as u64,
            &mut first_json_event_ms,
            &mut first_assistant_message_ms,
            &mut first_result_message_ms,
            &mut stdout_json_lines,
            &mut stdout_parse_errors,
        );
    }

    let first_byte_ms = match (first_stdout_ms, first_stderr_ms) {
        (Some(out), Some(err)) => Some(out.min(err)),
        (Some(out), None) => Some(out),
        (None, Some(err)) => Some(err),
        (None, None) => None,
    };

    let stderr_bytes = tokio::fs::read(&stderr_path)
        .await
        .map(|bytes| bytes.len())
        .unwrap_or(0);

    let result = SessionStartupProbeResult {
        benchmark_kind: ProbeBenchmarkKind::AssistantIterm,
        provider_id: "claude".to_string(),
        project_path,
        model,
        timeout_ms,
        timed_out,
        total_ms: started_at.elapsed().as_millis() as u64,
        first_stdout_ms,
        first_stderr_ms,
        first_byte_ms,
        first_json_event_ms,
        first_assistant_message_ms,
        first_result_message_ms,
        stdout_json_lines,
        stdout_parse_errors,
        stdout_bytes,
        stderr_bytes,
        exit_code,
        signal: None,
    };

    let _ = std::fs::remove_dir_all(&probe_dir);

    Ok(result)
}

#[cfg(not(target_os = "macos"))]
async fn run_iterm_probe(
    _project_path: String,
    _model: String,
    _timeout_ms: u64,
    _claude_path: String,
    _args: Vec<String>,
) -> Result<SessionStartupProbeResult, String> {
    Err("assistant_iterm benchmark is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
async fn launch_native_terminal(project_path: &str, command_text: &str) -> Result<String, String> {
    let run_command = format!("cd {} && {}", shell_quote(project_path), command_text);
    let run_command_literal = applescript_quote(&run_command);

    let iterm_script = vec![
        format!(r#"set runCommand to "{}""#, run_command_literal),
        r#"tell application "iTerm""#.to_string(),
        r#"  activate"#.to_string(),
        r#"  if (count of windows) = 0 then"#.to_string(),
        r#"    create window with default profile"#.to_string(),
        r#"  end if"#.to_string(),
        r#"  tell current session of current window"#.to_string(),
        r#"    write text runCommand"#.to_string(),
        r#"  end tell"#.to_string(),
        r#"end tell"#.to_string(),
    ];

    match run_osascript_lines(iterm_script).await {
        Ok(()) => return Ok("iTerm".to_string()),
        Err(iterm_error) => {
            let terminal_script = vec![
                format!(r#"set runCommand to "{}""#, run_command_literal),
                r#"tell application "Terminal""#.to_string(),
                r#"  activate"#.to_string(),
                r#"  do script runCommand"#.to_string(),
                r#"end tell"#.to_string(),
            ];

            match run_osascript_lines(terminal_script).await {
                Ok(()) => Ok("Terminal.app".to_string()),
                Err(terminal_error) => Err(format!(
                    "Failed to launch native terminal. iTerm error: {}. Terminal.app error: {}",
                    iterm_error, terminal_error
                )),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
async fn launch_native_terminal(_project_path: &str, _command_text: &str) -> Result<String, String> {
    Err("Native terminal launch is currently supported on macOS only.".to_string())
}

#[tauri::command]
pub async fn open_external_terminal(project_path: String, command: Option<String>) -> Result<String, String> {
    let path = PathBuf::from(&project_path);
    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    if !path.is_dir() {
        return Err(format!("Project path is not a directory: {}", project_path));
    }

    let command_text = command
        .unwrap_or_else(|| "claude".to_string())
        .trim()
        .to_string();

    let command_text = if command_text.is_empty() {
        "claude".to_string()
    } else {
        command_text
    };

    launch_native_terminal(&project_path, &command_text).await
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
        Some("assistant_iterm") => ProbeBenchmarkKind::AssistantIterm,
        Some("assistant") => ProbeBenchmarkKind::Assistant,
        _ => ProbeBenchmarkKind::Startup,
    };

    let claude_path = match benchmark_kind.clone() {
        ProbeBenchmarkKind::AssistantIterm => resolve_iterm_probe_binary(&app)?,
        _ => find_claude_binary(&app)?,
    };
    let args = build_probe_args(&prompt, &model, include_partial_messages);

    match benchmark_kind.clone() {
        ProbeBenchmarkKind::AssistantIterm => {
            run_iterm_probe(project_path, model, timeout_ms, claude_path, args).await
        }
        _ => run_direct_probe(benchmark_kind, project_path, model, timeout_ms, claude_path, args).await,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_which_output, select_iterm_probe_binary};

    #[test]
    fn parse_which_output_handles_alias_format() {
        let parsed = parse_which_output("claude: aliased to /opt/homebrew/bin/claude\n");
        assert_eq!(parsed.as_deref(), Some("/opt/homebrew/bin/claude"));
    }

    #[test]
    fn select_iterm_probe_binary_accepts_cli_command_name() {
        let selected =
            select_iterm_probe_binary(Some("claude".to_string()), Some("/tmp/unused".to_string())).unwrap();
        assert_eq!(selected, "claude");
    }

    #[test]
    fn select_iterm_probe_binary_falls_back_when_which_is_app_bundle() {
        let selected = select_iterm_probe_binary(
            Some("/Applications/Claude.app/Contents/MacOS/Claude".to_string()),
            Some("/opt/homebrew/bin/claude".to_string()),
        )
        .unwrap();
        assert_eq!(selected, "/opt/homebrew/bin/claude");
    }

    #[test]
    fn select_iterm_probe_binary_rejects_disallowed_fallback() {
        let error = select_iterm_probe_binary(
            Some("/Applications/Claude.app/Contents/MacOS/Claude".to_string()),
            Some("/Applications/Claude.app/Contents/MacOS/Claude".to_string()),
        )
        .unwrap_err();
        assert!(error.contains("GUI app bundle"));
    }
}
