use crate::usage_index::{DailyUsage, ModelUsage, ProjectUsage, UsageEntry, UsageStats};
use rusqlite::{params_from_iter, types::ToSql, Connection};

const MAX_LIMIT: u32 = 500;

fn add_date_filters(
    sql: &mut String,
    params: &mut Vec<Box<dyn ToSql>>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) {
    if let Some(start) = start_date {
        sql.push_str(" AND event_date >= ?");
        params.push(Box::new(start.to_string()));
    }
    if let Some(end) = end_date {
        sql.push_str(" AND event_date <= ?");
        params.push(Box::new(end.to_string()));
    }
}

pub fn query_usage_stats(
    conn: &Connection,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<UsageStats, String> {
    let mut stats = UsageStats::default();

    let mut base_sql = String::from(
        "SELECT \
         COALESCE(SUM(cost), 0), \
         COALESCE(SUM(input_tokens), 0), \
         COALESCE(SUM(output_tokens), 0), \
         COALESCE(SUM(cache_creation_tokens), 0), \
         COALESCE(SUM(cache_read_tokens), 0), \
         COALESCE(COUNT(DISTINCT session_id), 0) \
         FROM usage_events WHERE 1=1",
    );
    let mut base_params: Vec<Box<dyn ToSql>> = Vec::new();
    add_date_filters(&mut base_sql, &mut base_params, start_date, end_date);

    let mut stmt = conn
        .prepare(&base_sql)
        .map_err(|e| format!("Failed to prepare usage totals query: {}", e))?;

    let (total_cost, input, output, cache_creation, cache_read, sessions):
        (f64, i64, i64, i64, i64, i64) = stmt
        .query_row(params_from_iter(base_params.iter().map(|p| p.as_ref())), |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| format!("Failed to execute usage totals query: {}", e))?;

    stats.total_cost = total_cost;
    stats.total_input_tokens = input.max(0) as u64;
    stats.total_output_tokens = output.max(0) as u64;
    stats.total_cache_creation_tokens = cache_creation.max(0) as u64;
    stats.total_cache_read_tokens = cache_read.max(0) as u64;
    stats.total_sessions = sessions.max(0) as u64;
    stats.total_tokens = stats.total_input_tokens
        + stats.total_output_tokens
        + stats.total_cache_creation_tokens
        + stats.total_cache_read_tokens;

    let mut model_sql = String::from(
        "SELECT model, \
         COALESCE(SUM(cost), 0), \
         COALESCE(SUM(input_tokens), 0), \
         COALESCE(SUM(output_tokens), 0), \
         COALESCE(SUM(cache_creation_tokens), 0), \
         COALESCE(SUM(cache_read_tokens), 0), \
         COALESCE(COUNT(DISTINCT session_id), 0) \
         FROM usage_events WHERE 1=1",
    );
    let mut model_params: Vec<Box<dyn ToSql>> = Vec::new();
    add_date_filters(&mut model_sql, &mut model_params, start_date, end_date);
    model_sql.push_str(" GROUP BY model ORDER BY SUM(cost) DESC");

    let mut model_stmt = conn
        .prepare(&model_sql)
        .map_err(|e| format!("Failed to prepare model usage query: {}", e))?;

    let model_rows = model_stmt
        .query_map(
            params_from_iter(model_params.iter().map(|p| p.as_ref())),
            |row| {
                let input_tokens = row.get::<_, i64>(2)?.max(0) as u64;
                let output_tokens = row.get::<_, i64>(3)?.max(0) as u64;
                let cache_creation_tokens = row.get::<_, i64>(4)?.max(0) as u64;
                let cache_read_tokens = row.get::<_, i64>(5)?.max(0) as u64;
                Ok(ModelUsage {
                    model: row.get::<_, String>(0)?,
                    total_cost: row.get::<_, f64>(1)?,
                    total_tokens: input_tokens
                        + output_tokens
                        + cache_creation_tokens
                        + cache_read_tokens,
                    input_tokens,
                    output_tokens,
                    cache_creation_tokens,
                    cache_read_tokens,
                    session_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .map_err(|e| format!("Failed to execute model usage query: {}", e))?;

    stats.by_model = model_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse model usage rows: {}", e))?;

    let mut daily_sql = String::from(
        "SELECT event_date, \
         COALESCE(SUM(cost), 0), \
         COALESCE(SUM(input_tokens), 0), \
         COALESCE(SUM(output_tokens), 0), \
         COALESCE(SUM(cache_creation_tokens), 0), \
         COALESCE(SUM(cache_read_tokens), 0), \
         COALESCE(GROUP_CONCAT(DISTINCT model), '') \
         FROM usage_events WHERE 1=1",
    );
    let mut daily_params: Vec<Box<dyn ToSql>> = Vec::new();
    add_date_filters(&mut daily_sql, &mut daily_params, start_date, end_date);
    daily_sql.push_str(" GROUP BY event_date ORDER BY event_date DESC");

    let mut daily_stmt = conn
        .prepare(&daily_sql)
        .map_err(|e| format!("Failed to prepare daily usage query: {}", e))?;

    let daily_rows = daily_stmt
        .query_map(
            params_from_iter(daily_params.iter().map(|p| p.as_ref())),
            |row| {
                let models_csv = row.get::<_, String>(6)?;
                let models_used = models_csv
                    .split(',')
                    .filter(|entry| !entry.is_empty())
                    .map(|entry| entry.to_string())
                    .collect::<Vec<_>>();
                let input_tokens = row.get::<_, i64>(2)?.max(0) as u64;
                let output_tokens = row.get::<_, i64>(3)?.max(0) as u64;
                let cache_creation_tokens = row.get::<_, i64>(4)?.max(0) as u64;
                let cache_read_tokens = row.get::<_, i64>(5)?.max(0) as u64;
                Ok(DailyUsage {
                    date: row.get::<_, String>(0)?,
                    total_cost: row.get::<_, f64>(1)?,
                    total_tokens: input_tokens
                        + output_tokens
                        + cache_creation_tokens
                        + cache_read_tokens,
                    models_used,
                })
            },
        )
        .map_err(|e| format!("Failed to execute daily usage query: {}", e))?;

    stats.by_date = daily_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse daily usage rows: {}", e))?;

    let mut project_sql = String::from(
        "SELECT project_path, \
         MIN(project_name), \
         COALESCE(SUM(cost), 0), \
         COALESCE(SUM(input_tokens), 0), \
         COALESCE(SUM(output_tokens), 0), \
         COALESCE(SUM(cache_creation_tokens), 0), \
         COALESCE(SUM(cache_read_tokens), 0), \
         COALESCE(COUNT(DISTINCT session_id), 0), \
         COALESCE(MAX(timestamp), '') \
         FROM usage_events WHERE 1=1",
    );
    let mut project_params: Vec<Box<dyn ToSql>> = Vec::new();
    add_date_filters(&mut project_sql, &mut project_params, start_date, end_date);
    project_sql.push_str(" GROUP BY project_path ORDER BY SUM(cost) DESC");

    let mut project_stmt = conn
        .prepare(&project_sql)
        .map_err(|e| format!("Failed to prepare project usage query: {}", e))?;

    let project_rows = project_stmt
        .query_map(
            params_from_iter(project_params.iter().map(|p| p.as_ref())),
            |row| {
                let input_tokens = row.get::<_, i64>(3)?.max(0) as u64;
                let output_tokens = row.get::<_, i64>(4)?.max(0) as u64;
                let cache_creation_tokens = row.get::<_, i64>(5)?.max(0) as u64;
                let cache_read_tokens = row.get::<_, i64>(6)?.max(0) as u64;
                Ok(ProjectUsage {
                    project_path: row.get::<_, String>(0)?,
                    project_name: row.get::<_, String>(1)?,
                    total_cost: row.get::<_, f64>(2)?,
                    total_tokens: input_tokens
                        + output_tokens
                        + cache_creation_tokens
                        + cache_read_tokens,
                    session_count: row.get::<_, i64>(7)?.max(0) as u64,
                    last_used: row.get::<_, String>(8)?,
                })
            },
        )
        .map_err(|e| format!("Failed to execute project usage query: {}", e))?;

    stats.by_project = project_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse project usage rows: {}", e))?;

    Ok(stats)
}

pub fn query_usage_details(
    conn: &Connection,
    project_path: Option<&str>,
    date_prefix: Option<&str>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<UsageEntry>, String> {
    let mut sql = String::from(
        "SELECT timestamp, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost, session_id, project_path \
         FROM usage_events WHERE 1=1",
    );
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(project) = project_path {
        sql.push_str(" AND project_path = ?");
        params.push(Box::new(project.to_string()));
    }

    if let Some(date) = date_prefix {
        sql.push_str(" AND event_date LIKE ?");
        params.push(Box::new(format!("{}%", date)));
    }

    let capped_limit = limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT) as i64;
    let resolved_offset = offset.unwrap_or(0) as i64;

    sql.push_str(" ORDER BY timestamp ASC LIMIT ? OFFSET ?");
    params.push(Box::new(capped_limit));
    params.push(Box::new(resolved_offset));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare usage details query: {}", e))?;

    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
            Ok(UsageEntry {
                timestamp: row.get::<_, String>(0)?,
                model: row.get::<_, String>(1)?,
                input_tokens: row.get::<_, i64>(2)?.max(0) as u64,
                output_tokens: row.get::<_, i64>(3)?.max(0) as u64,
                cache_creation_tokens: row.get::<_, i64>(4)?.max(0) as u64,
                cache_read_tokens: row.get::<_, i64>(5)?.max(0) as u64,
                cost: row.get::<_, f64>(6)?,
                session_id: row.get::<_, String>(7)?,
                project_path: row.get::<_, String>(8)?,
            })
        })
        .map_err(|e| format!("Failed to execute usage details query: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse usage details rows: {}", e))
}

pub fn query_session_stats(
    conn: &Connection,
    since_date: Option<&str>,
    until_date: Option<&str>,
    order: Option<&str>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<ProjectUsage>, String> {
    let mut sql = String::from(
        "SELECT project_path, session_id, \
         COALESCE(SUM(cost), 0), \
         COALESCE(SUM(input_tokens), 0), \
         COALESCE(SUM(output_tokens), 0), \
         COALESCE(SUM(cache_creation_tokens), 0), \
         COALESCE(SUM(cache_read_tokens), 0), \
         COALESCE(COUNT(*), 0), \
         COALESCE(MAX(timestamp), '') \
         FROM usage_events WHERE 1=1",
    );
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(since) = since_date {
        sql.push_str(" AND event_date >= ?");
        params.push(Box::new(since.to_string()));
    }
    if let Some(until) = until_date {
        sql.push_str(" AND event_date <= ?");
        params.push(Box::new(until.to_string()));
    }

    sql.push_str(" GROUP BY project_path, session_id");
    if order.unwrap_or("desc") == "asc" {
        sql.push_str(" ORDER BY MAX(timestamp) ASC");
    } else {
        sql.push_str(" ORDER BY MAX(timestamp) DESC");
    }

    let capped_limit = limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT) as i64;
    let resolved_offset = offset.unwrap_or(0) as i64;
    sql.push_str(" LIMIT ? OFFSET ?");
    params.push(Box::new(capped_limit));
    params.push(Box::new(resolved_offset));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare session usage query: {}", e))?;

    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
            let input_tokens = row.get::<_, i64>(3)?.max(0) as u64;
            let output_tokens = row.get::<_, i64>(4)?.max(0) as u64;
            let cache_creation_tokens = row.get::<_, i64>(5)?.max(0) as u64;
            let cache_read_tokens = row.get::<_, i64>(6)?.max(0) as u64;
            Ok(ProjectUsage {
                project_path: row.get::<_, String>(0)?,
                project_name: row.get::<_, String>(1)?,
                total_cost: row.get::<_, f64>(2)?,
                total_tokens: input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens,
                session_count: row.get::<_, i64>(7)?.max(0) as u64,
                last_used: row.get::<_, String>(8)?,
            })
        })
        .map_err(|e| format!("Failed to execute session usage query: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse session usage rows: {}", e))
}
