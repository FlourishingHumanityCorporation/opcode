use chrono::{DateTime, Local, NaiveDate};
use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use tauri::{command, AppHandle, State};

use crate::usage_index::query::{query_session_stats, query_usage_details, query_usage_stats};
use crate::usage_index::sync::run_usage_index_sync;
use crate::usage_index::{
    append_usage_debug_log, open_usage_index_connection, UsageEntry, UsageIndexState, UsageIndexStatus,
    UsageStats,
};

fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn panic_safe<T, F>(operation: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    append_usage_debug_log(&format!("{} start", operation));
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => match result {
            Ok(value) => {
                append_usage_debug_log(&format!("{} success", operation));
                Ok(value)
            }
            Err(error) => {
                append_usage_debug_log(&format!("{} error: {}", operation, error));
                Err(error)
            }
        },
        Err(payload) => {
            let panic_message = format!("{} panicked: {}", operation, panic_payload_to_string(payload));
            append_usage_debug_log(&panic_message);
            Err(panic_message)
        }
    }
}

fn parse_date_input(input: &str, label: &str) -> Result<String, String> {
    if let Ok(date) = NaiveDate::parse_from_str(input, "%Y-%m-%d") {
        return Ok(date.format("%Y-%m-%d").to_string());
    }

    if let Ok(date_time) = DateTime::parse_from_rfc3339(input) {
        return Ok(date_time.naive_local().date().format("%Y-%m-%d").to_string());
    }

    Err(format!("Invalid {}: {}", label, input))
}

fn parse_compact_date(input: &str) -> Option<String> {
    NaiveDate::parse_from_str(input, "%Y%m%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

#[command]
pub fn get_usage_index_status(state: State<'_, UsageIndexState>) -> Result<UsageIndexStatus, String> {
    Ok(state.snapshot())
}

#[command]
pub fn start_usage_index_sync(
    app: AppHandle,
    state: State<'_, UsageIndexState>,
) -> Result<UsageIndexStatus, String> {
    if !state.try_start() {
        return Ok(state.snapshot());
    }

    state.mark_started(0);

    let app_handle = app.clone();
    let state_for_task = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let result = run_usage_index_sync(&app_handle, &state_for_task);
        match result {
            Ok(outcome) => {
                if outcome.cancelled {
                    state_for_task.mark_cancelled(&outcome);
                } else {
                    state_for_task.mark_completed(&outcome);
                }
            }
            Err(error) => {
                append_usage_debug_log(&format!("usage_index_sync error: {}", error));
                state_for_task.mark_error(&error);
            }
        }

        state_for_task.finish();
    });

    Ok(state.snapshot())
}

#[command]
pub fn cancel_usage_index_sync(
    state: State<'_, UsageIndexState>,
) -> Result<UsageIndexStatus, String> {
    state.request_cancel();
    append_usage_debug_log("usage_index_sync cancel requested");
    Ok(state.snapshot())
}

#[command]
pub fn get_usage_stats(days: Option<u32>, app: AppHandle) -> Result<UsageStats, String> {
    panic_safe("get_usage_stats", || {
        let start_date = days.map(|value| {
            (Local::now().naive_local().date() - chrono::Duration::days(value as i64))
                .format("%Y-%m-%d")
                .to_string()
        });

        let conn = open_usage_index_connection(&app)?;
        query_usage_stats(&conn, start_date.as_deref(), None)
    })
}

#[command]
pub fn get_usage_by_date_range(
    start_date: String,
    end_date: String,
    app: AppHandle,
) -> Result<UsageStats, String> {
    panic_safe("get_usage_by_date_range", || {
        let start = parse_date_input(&start_date, "start date")?;
        let end = parse_date_input(&end_date, "end date")?;

        let conn = open_usage_index_connection(&app)?;
        query_usage_stats(&conn, Some(start.as_str()), Some(end.as_str()))
    })
}

#[command]
pub fn get_usage_details(
    project_path: Option<String>,
    date: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    app: AppHandle,
) -> Result<Vec<UsageEntry>, String> {
    panic_safe("get_usage_details", || {
        let conn = open_usage_index_connection(&app)?;
        query_usage_details(
            &conn,
            project_path.as_deref(),
            date.as_deref(),
            limit,
            offset,
        )
    })
}

#[command]
pub fn get_session_stats(
    since: Option<String>,
    until: Option<String>,
    order: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    app: AppHandle,
) -> Result<Vec<crate::usage_index::ProjectUsage>, String> {
    panic_safe("get_session_stats", || {
        let since_date = since.as_deref().and_then(parse_compact_date);
        let until_date = until.as_deref().and_then(parse_compact_date);

        let conn = open_usage_index_connection(&app)?;
        query_session_stats(
            &conn,
            since_date.as_deref(),
            until_date.as_deref(),
            order.as_deref(),
            limit,
            offset,
        )
    })
}
