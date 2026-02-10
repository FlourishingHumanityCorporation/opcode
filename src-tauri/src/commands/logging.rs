/// Receives log events forwarded from the frontend (React/TypeScript).
/// These are written into the same tracing file appender as backend logs,
/// prefixed with `[frontend]` to distinguish from Rust-originated entries.
#[tauri::command]
pub async fn log_frontend_event(
    module: String,
    level: String,
    message: String,
    context: Option<String>,
) -> Result<(), String> {
    let ctx_str = context.as_deref().unwrap_or("");

    match level.as_str() {
        "error" => tracing::error!(target: "frontend", module = %module, context = %ctx_str, "{}", message),
        "warn" => tracing::warn!(target: "frontend", module = %module, context = %ctx_str, "{}", message),
        "info" => tracing::info!(target: "frontend", module = %module, context = %ctx_str, "{}", message),
        "debug" => tracing::debug!(target: "frontend", module = %module, context = %ctx_str, "{}", message),
        _ => tracing::info!(target: "frontend", module = %module, context = %ctx_str, "{}", message),
    }

    Ok(())
}
