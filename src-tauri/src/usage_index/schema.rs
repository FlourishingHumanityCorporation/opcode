use rusqlite::Connection;

pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS usage_events (
            event_uid TEXT PRIMARY KEY,
            source_path TEXT NOT NULL,
            source_line INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            event_date TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_creation_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cost REAL NOT NULL,
            session_id TEXT NOT NULL,
            project_path TEXT NOT NULL,
            project_name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_files (
            source_path TEXT PRIMARY KEY,
            size_bytes INTEGER NOT NULL,
            modified_unix_ms INTEGER NOT NULL,
            last_offset INTEGER NOT NULL,
            last_line INTEGER NOT NULL,
            last_scanned_at TEXT NOT NULL,
            parse_error_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_usage_events_event_date ON usage_events(event_date);
        CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
        CREATE INDEX IF NOT EXISTS idx_usage_events_project_path ON usage_events(project_path);
        CREATE INDEX IF NOT EXISTS idx_usage_events_session_id ON usage_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_events_source_path ON usage_events(source_path);
        "#,
    )
    .map_err(|e| format!("Failed to initialize usage index schema: {}", e))?;

    Ok(())
}
