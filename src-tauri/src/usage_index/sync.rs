use crate::usage_index::{
    append_usage_debug_log, open_usage_index_connection, SyncOutcome, UsageIndexState,
};
use chrono::{DateTime, Local};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const COMMIT_EVERY_LINES: u64 = 5_000;

const OPUS_4_INPUT_PRICE: f64 = 15.0;
const OPUS_4_OUTPUT_PRICE: f64 = 75.0;
const OPUS_4_CACHE_WRITE_PRICE: f64 = 18.75;
const OPUS_4_CACHE_READ_PRICE: f64 = 1.50;

const SONNET_4_INPUT_PRICE: f64 = 3.0;
const SONNET_4_OUTPUT_PRICE: f64 = 15.0;
const SONNET_4_CACHE_WRITE_PRICE: f64 = 3.75;
const SONNET_4_CACHE_READ_PRICE: f64 = 0.30;

#[derive(Debug, Clone)]
struct SourceFileRow {
    source_path: String,
    size_bytes: i64,
    modified_unix_ms: i64,
    last_offset: i64,
    last_line: i64,
    parse_error_count: i64,
}

#[derive(Debug)]
struct ParsedUsageEvent {
    event_uid: String,
    source_path: String,
    source_line: i64,
    timestamp: String,
    event_date: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    cost: f64,
    session_id: String,
    project_path: String,
    project_name: String,
}

#[derive(Debug)]
struct FileProcessResult {
    lines_processed: u64,
    entries_indexed: u64,
    entries_ignored: u64,
    parse_errors: u64,
}

#[derive(Debug, Deserialize)]
struct JsonlEntry {
    timestamp: String,
    message: Option<MessageData>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct MessageData {
    id: Option<String>,
    model: Option<String>,
    usage: Option<UsageData>,
}

#[derive(Debug, Deserialize)]
struct UsageData {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

fn calculate_cost(model: &str, usage: &UsageData) -> f64 {
    let input_tokens = usage.input_tokens.unwrap_or(0) as f64;
    let output_tokens = usage.output_tokens.unwrap_or(0) as f64;
    let cache_creation_tokens = usage.cache_creation_input_tokens.unwrap_or(0) as f64;
    let cache_read_tokens = usage.cache_read_input_tokens.unwrap_or(0) as f64;

    let (input_price, output_price, cache_write_price, cache_read_price) =
        if model.contains("opus-4") || model.contains("claude-opus-4") {
            (
                OPUS_4_INPUT_PRICE,
                OPUS_4_OUTPUT_PRICE,
                OPUS_4_CACHE_WRITE_PRICE,
                OPUS_4_CACHE_READ_PRICE,
            )
        } else if model.contains("sonnet-4") || model.contains("claude-sonnet-4") {
            (
                SONNET_4_INPUT_PRICE,
                SONNET_4_OUTPUT_PRICE,
                SONNET_4_CACHE_WRITE_PRICE,
                SONNET_4_CACHE_READ_PRICE,
            )
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

    (input_tokens * input_price / 1_000_000.0)
        + (output_tokens * output_price / 1_000_000.0)
        + (cache_creation_tokens * cache_write_price / 1_000_000.0)
        + (cache_read_tokens * cache_read_price / 1_000_000.0)
}

fn parse_event_date(timestamp: &str) -> Option<String> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(timestamp) {
        return Some(dt.naive_local().date().format("%Y-%m-%d").to_string());
    }

    timestamp.get(0..10).map(|s| s.to_string())
}

fn infer_project_hint(path: &Path) -> String {
    let mut components = path.components().peekable();
    while let Some(component) = components.next() {
        if component.as_os_str() == "projects" {
            if let Some(project_component) = components.next() {
                return project_component.as_os_str().to_string_lossy().to_string();
            }
            break;
        }
    }

    path.parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn infer_project_name(project_path: &str) -> String {
    Path::new(project_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| project_path.to_string())
}

fn file_mtime_unix_ms(path: &Path) -> Result<i64, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", path.display(), e))?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let millis = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    Ok(millis)
}

fn file_size_bytes(path: &Path) -> Result<i64, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", path.display(), e))?;
    Ok(metadata.len() as i64)
}

fn list_usage_jsonl_files() -> Result<Vec<PathBuf>, String> {
    let claude_path = dirs::home_dir()
        .ok_or("Failed to resolve home directory")?
        .join(".claude")
        .join("projects");

    if !claude_path.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(claude_path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
    {
        files.push(entry.path().to_path_buf());
    }

    files.sort();
    Ok(files)
}

fn load_source_file_row(conn: &Connection, source_path: &str) -> Result<Option<SourceFileRow>, String> {
    conn.query_row(
        "SELECT source_path, size_bytes, modified_unix_ms, last_offset, last_line, parse_error_count \
         FROM source_files WHERE source_path = ?1",
        params![source_path],
        |row| {
            Ok(SourceFileRow {
                source_path: row.get(0)?,
                size_bytes: row.get(1)?,
                modified_unix_ms: row.get(2)?,
                last_offset: row.get(3)?,
                last_line: row.get(4)?,
                parse_error_count: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("Failed to load source file row for {}: {}", source_path, e))
}

fn remove_deleted_files(conn: &mut Connection, existing_paths: &HashSet<String>) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT source_path FROM source_files")
        .map_err(|e| format!("Failed to load tracked source files: {}", e))?;
    let tracked = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query tracked source files: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse tracked source files: {}", e))?;
    drop(stmt);

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start cleanup transaction: {}", e))?;

    for source_path in tracked {
        if existing_paths.contains(&source_path) {
            continue;
        }
        tx.execute(
            "DELETE FROM usage_events WHERE source_path = ?1",
            params![source_path],
        )
        .map_err(|e| format!("Failed to delete usage events for removed file: {}", e))?;
        tx.execute(
            "DELETE FROM source_files WHERE source_path = ?1",
            params![source_path],
        )
        .map_err(|e| format!("Failed to delete source file row for removed file: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit removed-file cleanup: {}", e))?;

    Ok(())
}

fn upsert_source_file_row(
    tx: &Transaction<'_>,
    source_path: &str,
    size_bytes: i64,
    modified_unix_ms: i64,
    last_offset: i64,
    last_line: i64,
    parse_error_count: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO source_files \
         (source_path, size_bytes, modified_unix_ms, last_offset, last_line, last_scanned_at, parse_error_count) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(source_path) DO UPDATE SET \
           size_bytes = excluded.size_bytes, \
           modified_unix_ms = excluded.modified_unix_ms, \
           last_offset = excluded.last_offset, \
           last_line = excluded.last_line, \
           last_scanned_at = excluded.last_scanned_at, \
           parse_error_count = excluded.parse_error_count",
        params![
            source_path,
            size_bytes,
            modified_unix_ms,
            last_offset,
            last_line,
            Local::now().to_rfc3339(),
            parse_error_count,
        ],
    )
    .map_err(|e| format!("Failed to upsert source file row: {}", e))?;

    Ok(())
}

fn insert_usage_event(tx: &Transaction<'_>, event: &ParsedUsageEvent) -> Result<bool, String> {
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO usage_events \
             (event_uid, source_path, source_line, timestamp, event_date, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost, session_id, project_path, project_name) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                event.event_uid,
                event.source_path,
                event.source_line,
                event.timestamp,
                event.event_date,
                event.model,
                event.input_tokens,
                event.output_tokens,
                event.cache_creation_tokens,
                event.cache_read_tokens,
                event.cost,
                event.session_id,
                event.project_path,
                event.project_name,
            ],
        )
        .map_err(|e| format!("Failed to insert usage event: {}", e))?;

    Ok(inserted > 0)
}

fn parse_usage_event(
    line: &str,
    source_path: &str,
    source_line: i64,
    fallback_project_hint: &str,
    discovered_project_path: &mut Option<String>,
    fallback_session_id: &str,
) -> Result<Option<ParsedUsageEvent>, String> {
    let json_value = serde_json::from_str::<serde_json::Value>(line)
        .map_err(|e| format!("Invalid JSON at {}:{} ({})", source_path, source_line, e))?;

    if discovered_project_path.is_none() {
        if let Some(cwd) = json_value.get("cwd").and_then(|value| value.as_str()) {
            *discovered_project_path = Some(cwd.to_string());
        }
    }

    let entry: JsonlEntry = serde_json::from_value(json_value)
        .map_err(|e| format!("Invalid usage envelope at {}:{} ({})", source_path, source_line, e))?;

    let message = match entry.message {
        Some(message) => message,
        None => return Ok(None),
    };

    let usage = match message.usage {
        Some(usage) => usage,
        None => return Ok(None),
    };

    let input_tokens = usage.input_tokens.unwrap_or(0);
    let output_tokens = usage.output_tokens.unwrap_or(0);
    let cache_creation_tokens = usage.cache_creation_input_tokens.unwrap_or(0);
    let cache_read_tokens = usage.cache_read_input_tokens.unwrap_or(0);

    if input_tokens == 0
        && output_tokens == 0
        && cache_creation_tokens == 0
        && cache_read_tokens == 0
    {
        return Ok(None);
    }

    let event_date = match parse_event_date(&entry.timestamp) {
        Some(date) => date,
        None => return Ok(None),
    };

    let model = message.model.unwrap_or_else(|| "unknown".to_string());
    let cost = entry
        .cost_usd
        .unwrap_or_else(|| calculate_cost(&model, &usage));

    let session_id = entry
        .session_id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_session_id.to_string());

    let project_path = discovered_project_path
        .clone()
        .unwrap_or_else(|| fallback_project_hint.to_string());
    let project_name = infer_project_name(&project_path);

    let event_uid = if let (Some(message_id), Some(request_id)) = (message.id, entry.request_id) {
        format!("mr:{}:{}", message_id, request_id)
    } else {
        format!("ln:{}:{}", source_path, source_line)
    };

    Ok(Some(ParsedUsageEvent {
        event_uid,
        source_path: source_path.to_string(),
        source_line,
        timestamp: entry.timestamp,
        event_date,
        model,
        input_tokens: input_tokens as i64,
        output_tokens: output_tokens as i64,
        cache_creation_tokens: cache_creation_tokens as i64,
        cache_read_tokens: cache_read_tokens as i64,
        cost,
        session_id,
        project_path,
        project_name,
    }))
}

fn process_file(
    conn: &mut Connection,
    state: &UsageIndexState,
    path: &Path,
    file_index: u64,
    total_files: u64,
    outcome: &mut SyncOutcome,
) -> Result<(), String> {
    let source_path = path.to_string_lossy().to_string();
    let size_bytes = file_size_bytes(path)?;
    let modified_unix_ms = file_mtime_unix_ms(path)?;

    let existing = load_source_file_row(conn, &source_path)?;

    let mut start_offset = 0i64;
    let mut start_line = 0i64;
    let mut base_parse_errors = existing.as_ref().map(|row| row.parse_error_count).unwrap_or(0);

    if let Some(row) = &existing {
        let truncated = size_bytes < row.last_offset;
        let rewritten_same_size = size_bytes == row.size_bytes && modified_unix_ms != row.modified_unix_ms;

        if truncated || rewritten_same_size {
            append_usage_debug_log(&format!(
                "usage_index_sync reset source={} reason={}",
                source_path,
                if truncated { "truncated" } else { "rewritten" }
            ));
            conn.execute(
                "DELETE FROM usage_events WHERE source_path = ?1",
                params![source_path],
            )
            .map_err(|e| format!("Failed to clear rewritten source events: {}", e))?;
            conn.execute(
                "DELETE FROM source_files WHERE source_path = ?1",
                params![source_path],
            )
            .map_err(|e| format!("Failed to clear rewritten source row: {}", e))?;
            base_parse_errors = 0;
        } else {
            start_offset = row.last_offset;
            start_line = row.last_line;
        }
    }

    let mut file = File::open(path)
        .map_err(|e| format!("Failed to open usage file {}: {}", path.display(), e))?;
    file.seek(SeekFrom::Start(start_offset as u64))
        .map_err(|e| format!("Failed to seek usage file {}: {}", path.display(), e))?;

    let fallback_project_hint = infer_project_hint(path);
    let fallback_session_id = path
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    state.update_status(|status| {
        status.current_file = Some(source_path.clone());
        status.files_total = total_files;
        status.files_processed = file_index.saturating_sub(1);
    });

    let mut reader = BufReader::new(file);
    let mut current_offset = start_offset;
    let mut current_line = start_line;
    let mut batch_lines = 0u64;

    let mut discovered_project_path: Option<String> = None;

    let mut lines_processed = 0u64;
    let mut entries_indexed = 0u64;
    let mut entries_ignored = 0u64;
    let mut parse_errors = 0u64;

    let mut tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start usage file transaction: {}", e))?;

    let mut line = String::new();
    loop {
        if state.is_cancel_requested() {
            break;
        }

        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed reading usage file {}: {}", path.display(), e))?;
        if bytes_read == 0 {
            break;
        }

        current_offset += bytes_read as i64;
        current_line += 1;
        lines_processed += 1;
        batch_lines += 1;

        if line.trim().is_empty() {
            continue;
        }

        match parse_usage_event(
            &line,
            &source_path,
            current_line,
            &fallback_project_hint,
            &mut discovered_project_path,
            &fallback_session_id,
        ) {
            Ok(Some(event)) => {
                if insert_usage_event(&tx, &event)? {
                    entries_indexed += 1;
                } else {
                    entries_ignored += 1;
                }
            }
            Ok(None) => {}
            Err(_) => {
                parse_errors += 1;
            }
        }

        if batch_lines >= COMMIT_EVERY_LINES {
            upsert_source_file_row(
                &tx,
                &source_path,
                size_bytes,
                modified_unix_ms,
                current_offset,
                current_line,
                base_parse_errors + parse_errors as i64,
            )?;
            tx.commit()
                .map_err(|e| format!("Failed to commit usage file batch: {}", e))?;
            tx = conn
                .transaction()
                .map_err(|e| format!("Failed to reopen usage file transaction: {}", e))?;

            batch_lines = 0;
            state.update_status(|status| {
                status.lines_processed = outcome.lines_processed + lines_processed;
                status.entries_indexed = outcome.entries_indexed + entries_indexed;
                status.current_file = Some(source_path.clone());
            });

            append_usage_debug_log(&format!(
                "usage_index_sync progress file={} file_index={}/{} lines_processed={} entries_indexed={} entries_ignored={} parse_errors={}",
                source_path,
                file_index,
                total_files,
                lines_processed,
                entries_indexed,
                entries_ignored,
                parse_errors
            ));
        }
    }

    upsert_source_file_row(
        &tx,
        &source_path,
        size_bytes,
        modified_unix_ms,
        current_offset,
        current_line,
        base_parse_errors + parse_errors as i64,
    )?;
    tx.commit()
        .map_err(|e| format!("Failed to commit final usage file batch: {}", e))?;

    outcome.lines_processed += lines_processed;
    outcome.entries_indexed += entries_indexed;
    outcome.entries_ignored += entries_ignored;
    outcome.parse_errors += parse_errors;

    let file_result = FileProcessResult {
        lines_processed,
        entries_indexed,
        entries_ignored,
        parse_errors,
    };

    append_usage_debug_log(&format!(
        "usage_index_sync file complete path={} lines={} indexed={} ignored={} parse_errors={} final_offset={} final_line={}",
        source_path,
        file_result.lines_processed,
        file_result.entries_indexed,
        file_result.entries_ignored,
        file_result.parse_errors,
        current_offset,
        current_line
    ));

    state.update_status(|status| {
        status.files_processed = file_index;
        status.lines_processed = outcome.lines_processed;
        status.entries_indexed = outcome.entries_indexed;
        status.current_file = Some(source_path);
    });

    Ok(())
}

pub fn run_usage_index_sync(app: &AppHandle, state: &UsageIndexState) -> Result<SyncOutcome, String> {
    let started_at = Local::now();
    append_usage_debug_log("usage_index_sync start");

    let mut conn = open_usage_index_connection(app)?;
    let files = list_usage_jsonl_files()?;

    let mut tracked_paths = HashSet::new();
    for path in &files {
        tracked_paths.insert(path.to_string_lossy().to_string());
    }

    remove_deleted_files(&mut conn, &tracked_paths)?;

    let mut outcome = SyncOutcome::default();
    outcome.files_total = files.len() as u64;

    state.update_status(|status| {
        status.files_total = outcome.files_total;
        status.files_processed = 0;
        status.current_file = None;
    });

    for (index, path) in files.iter().enumerate() {
        if state.is_cancel_requested() {
            outcome.cancelled = true;
            break;
        }

        process_file(
            &mut conn,
            state,
            path,
            (index + 1) as u64,
            outcome.files_total,
            &mut outcome,
        )?;
        outcome.files_processed = (index + 1) as u64;
    }

    let duration = (Local::now() - started_at).num_milliseconds().max(0);

    if outcome.cancelled {
        append_usage_debug_log(&format!(
            "usage_index_sync cancelled duration_ms={} files_total={} files_processed={} lines_processed={} entries_indexed={} entries_ignored={} parse_errors={}",
            duration,
            outcome.files_total,
            outcome.files_processed,
            outcome.lines_processed,
            outcome.entries_indexed,
            outcome.entries_ignored,
            outcome.parse_errors
        ));
    } else {
        append_usage_debug_log(&format!(
            "usage_index_sync end duration_ms={} files_total={} files_processed={} lines_processed={} entries_indexed={} entries_ignored={} parse_errors={}",
            duration,
            outcome.files_total,
            outcome.files_processed,
            outcome.lines_processed,
            outcome.entries_indexed,
            outcome.entries_ignored,
            outcome.parse_errors
        ));
    }

    Ok(outcome)
}
