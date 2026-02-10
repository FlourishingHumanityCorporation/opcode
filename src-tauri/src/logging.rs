use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling;

/// Initialize the tracing infrastructure with:
/// 1. fmt layer → stdout (colored, human-readable, respects RUST_LOG)
/// 2. file appender → ~/.opcode/logs/opcode-YYYY-MM-DD.log (daily rotation)
/// 3. tracing-log::LogTracer → captures log:: from third-party deps (rusqlite, reqwest, etc.)
pub fn init() {
    // Bridge log:: crate calls from third-party deps into tracing
    tracing_log::LogTracer::init().ok();

    // Determine log directory: OPCODE_LOG_DIR env var or ~/.opcode/logs/
    let log_dir = std::env::var("OPCODE_LOG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".opcode")
                .join("logs")
        });

    // Ensure the log directory exists
    std::fs::create_dir_all(&log_dir).ok();

    // Daily rotating file appender
    let file_appender = rolling::daily(&log_dir, "opcode");

    // Non-blocking writer for the file appender
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // IMPORTANT: Leak the guard so it lives for the entire process lifetime.
    // If the guard is dropped, the non-blocking writer stops flushing.
    std::mem::forget(_guard);

    // Environment filter: respects RUST_LOG, defaults to info
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    // Stdout layer: colored, human-readable
    let stdout_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false);

    // File layer: no ANSI colors, includes timestamps
    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true);

    let init_result = tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(file_layer)
        .try_init();

    match init_result {
        Ok(()) => tracing::info!(log_dir = %log_dir.display(), "Logging initialized"),
        Err(err) => {
            eprintln!("Logging already initialized, continuing: {}", err);
            tracing::debug!(%err, "Logging subscriber already initialized");
        }
    }
}
