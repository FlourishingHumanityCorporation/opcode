use anyhow::Result;
use chrono;
use dirs;
use reqwest;
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
// Sidecar support removed; using system binary execution only
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command;

fn default_provider_id() -> String {
    "claude".to_string()
}

/// Finds the full path to the claude binary
/// This is necessary because macOS apps have a limited PATH environment
fn find_claude_binary(app_handle: &AppHandle) -> Result<String, String> {
    crate::claude_binary::find_claude_binary(app_handle)
}

/// Represents a CC Agent stored in the database
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Agent {
    pub id: Option<i64>,
    pub name: String,
    pub icon: String,
    pub system_prompt: String,
    pub default_task: Option<String>,
    #[serde(default = "default_provider_id")]
    pub provider_id: String,
    pub model: String,
    pub enable_file_read: bool,
    pub enable_file_write: bool,
    pub enable_network: bool,
    pub hooks: Option<String>, // JSON string of hooks configuration
    pub created_at: String,
    pub updated_at: String,
}

/// Represents an agent execution run
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentRun {
    pub id: Option<i64>,
    pub agent_id: i64,
    pub agent_name: String,
    pub agent_icon: String,
    #[serde(default = "default_provider_id")]
    pub provider_id: String,
    pub task: String,
    pub model: String,
    pub project_path: String,
    pub session_id: String, // UUID session ID from Claude Code
    pub output: Option<String>,
    pub status: String,     // 'pending', 'running', 'completed', 'failed', 'cancelled'
    pub pid: Option<u32>,
    pub process_started_at: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// Represents runtime metrics calculated from JSONL
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentRunMetrics {
    pub duration_ms: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub message_count: Option<i64>,
}

/// Combined agent run with real-time metrics
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentRunWithMetrics {
    #[serde(flatten)]
    pub run: AgentRun,
    pub metrics: Option<AgentRunMetrics>,
}

/// Agent export format
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentExport {
    pub version: u32,
    pub exported_at: String,
    pub agent: AgentData,
}

/// Agent data within export
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentData {
    pub name: String,
    pub icon: String,
    pub system_prompt: String,
    pub default_task: Option<String>,
    #[serde(default = "default_provider_id")]
    pub provider_id: String,
    pub model: String,
    pub hooks: Option<String>,
}

/// Runtime readiness status for a provider.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderRuntimeStatus {
    pub provider_id: String,
    pub installed: bool,
    pub auth_ready: bool,
    pub ready: bool,
    pub detected_binary: Option<String>,
    pub detected_version: Option<String>,
    pub issues: Vec<String>,
    pub setup_hints: Vec<String>,
}

/// Database connection state
pub struct AgentDb(pub Mutex<Connection>);

/// Real-time JSONL reading and processing functions
impl AgentRunMetrics {
    /// Calculate metrics from JSONL content
    pub fn from_jsonl(jsonl_content: &str) -> Self {
        let mut total_tokens = 0i64;
        let mut cost_usd = 0.0f64;
        let mut message_count = 0i64;
        let mut start_time: Option<chrono::DateTime<chrono::Utc>> = None;
        let mut end_time: Option<chrono::DateTime<chrono::Utc>> = None;

        for line in jsonl_content.lines() {
            if let Ok(json) = serde_json::from_str::<JsonValue>(line) {
                message_count += 1;

                // Track timestamps
                if let Some(timestamp_str) = json.get("timestamp").and_then(|t| t.as_str()) {
                    if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(timestamp_str) {
                        let utc_time = timestamp.with_timezone(&chrono::Utc);
                        if start_time.is_none() || utc_time < start_time.unwrap() {
                            start_time = Some(utc_time);
                        }
                        if end_time.is_none() || utc_time > end_time.unwrap() {
                            end_time = Some(utc_time);
                        }
                    }
                }

                // Extract token usage - check both top-level and nested message.usage
                let usage = json
                    .get("usage")
                    .or_else(|| json.get("message").and_then(|m| m.get("usage")));

                if let Some(usage) = usage {
                    if let Some(input_tokens) = usage.get("input_tokens").and_then(|t| t.as_i64()) {
                        total_tokens += input_tokens;
                    }
                    if let Some(output_tokens) = usage.get("output_tokens").and_then(|t| t.as_i64())
                    {
                        total_tokens += output_tokens;
                    }
                }

                // Extract cost information
                if let Some(cost) = json.get("cost").and_then(|c| c.as_f64()) {
                    cost_usd += cost;
                }
            }
        }

        let duration_ms = match (start_time, end_time) {
            (Some(start), Some(end)) => Some((end - start).num_milliseconds()),
            _ => None,
        };

        Self {
            duration_ms,
            total_tokens: if total_tokens > 0 {
                Some(total_tokens)
            } else {
                None
            },
            cost_usd: if cost_usd > 0.0 { Some(cost_usd) } else { None },
            message_count: if message_count > 0 {
                Some(message_count)
            } else {
                None
            },
        }
    }
}

/// Read JSONL content from a session file
pub async fn read_session_jsonl(session_id: &str, project_path: &str) -> Result<String, String> {
    let claude_dir = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude")
        .join("projects");

    // Encode project path to match Claude Code's directory naming
    let encoded_project = project_path.replace('/', "-");
    let project_dir = claude_dir.join(&encoded_project);
    let session_file = project_dir.join(format!("{}.jsonl", session_id));

    if !session_file.exists() {
        return Err(format!(
            "Session file not found: {}",
            session_file.display()
        ));
    }

    match tokio::fs::read_to_string(&session_file).await {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read session file: {}", e)),
    }
}

/// Get agent run with real-time metrics
pub async fn get_agent_run_with_metrics(run: AgentRun) -> AgentRunWithMetrics {
    let db_output = run.output.clone();

    // Claude sessions can be loaded directly from Claude JSONL files.
    if run.provider_id == "claude" && !run.session_id.is_empty() {
        if let Ok(jsonl_content) = read_session_jsonl(&run.session_id, &run.project_path).await {
            let metrics = AgentRunMetrics::from_jsonl(&jsonl_content);
            return AgentRunWithMetrics {
                run,
                metrics: Some(metrics),
            };
        }
    }

    if let Some(output) = db_output {
        let metrics = AgentRunMetrics::from_jsonl(&output);
        AgentRunWithMetrics {
            run,
            metrics: Some(metrics),
        }
    } else {
        AgentRunWithMetrics {
            run,
            metrics: None,
        }
    }
}

/// Initialize the agents database
pub fn init_database(app: &AppHandle) -> SqliteResult<Connection> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            tracing::error!("Failed to get app data directory: {}", e);
            rusqlite::Error::InvalidQuery
        })?;
    std::fs::create_dir_all(&app_dir).map_err(|e| {
        tracing::error!("Failed to create app data directory: {}", e);
        rusqlite::Error::InvalidQuery
    })?;

    let db_path = app_dir.join("agents.db");
    let conn = Connection::open(db_path)?;

    // Create agents table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            system_prompt TEXT NOT NULL,
            default_task TEXT,
            provider_id TEXT NOT NULL DEFAULT 'claude',
            model TEXT NOT NULL DEFAULT 'sonnet',
            enable_file_read BOOLEAN NOT NULL DEFAULT 1,
            enable_file_write BOOLEAN NOT NULL DEFAULT 1,
            enable_network BOOLEAN NOT NULL DEFAULT 0,
            hooks TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // Add columns to existing table if they don't exist
    let _ = conn.execute("ALTER TABLE agents ADD COLUMN default_task TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE agents ADD COLUMN provider_id TEXT DEFAULT 'claude'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agents ADD COLUMN model TEXT DEFAULT 'sonnet'",
        [],
    );
    let _ = conn.execute("ALTER TABLE agents ADD COLUMN hooks TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE agents ADD COLUMN enable_file_read BOOLEAN DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agents ADD COLUMN enable_file_write BOOLEAN DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agents ADD COLUMN enable_network BOOLEAN DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "UPDATE agents SET provider_id = 'claude' WHERE provider_id IS NULL OR provider_id = ''",
        [],
    );

    // Create agent_runs table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER NOT NULL,
            agent_name TEXT NOT NULL,
            agent_icon TEXT NOT NULL,
            provider_id TEXT NOT NULL DEFAULT 'claude',
            task TEXT NOT NULL,
            model TEXT NOT NULL,
            project_path TEXT NOT NULL,
            session_id TEXT NOT NULL,
            output TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            pid INTEGER,
            process_started_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Migrate existing agent_runs table if needed
    let _ = conn.execute("ALTER TABLE agent_runs ADD COLUMN session_id TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE agent_runs ADD COLUMN provider_id TEXT DEFAULT 'claude'",
        [],
    );
    let _ = conn.execute("ALTER TABLE agent_runs ADD COLUMN output TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE agent_runs ADD COLUMN status TEXT DEFAULT 'pending'",
        [],
    );
    let _ = conn.execute("ALTER TABLE agent_runs ADD COLUMN pid INTEGER", []);
    let _ = conn.execute(
        "ALTER TABLE agent_runs ADD COLUMN process_started_at TEXT",
        [],
    );

    // Drop old columns that are no longer needed (data is now read from JSONL files)
    // Note: SQLite doesn't support DROP COLUMN, so we'll ignore errors for existing columns
    let _ = conn.execute(
        "UPDATE agent_runs SET session_id = '' WHERE session_id IS NULL",
        [],
    );
    let _ = conn.execute("UPDATE agent_runs SET status = 'completed' WHERE status IS NULL AND completed_at IS NOT NULL", []);
    let _ = conn.execute("UPDATE agent_runs SET status = 'failed' WHERE status IS NULL AND completed_at IS NOT NULL AND session_id = ''", []);
    let _ = conn.execute(
        "UPDATE agent_runs SET provider_id = 'claude' WHERE provider_id IS NULL OR provider_id = ''",
        [],
    );
    let _ = conn.execute(
        "UPDATE agent_runs SET status = 'pending' WHERE status IS NULL",
        [],
    );

    // Create trigger to update the updated_at timestamp
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS update_agent_timestamp 
         AFTER UPDATE ON agents 
         FOR EACH ROW
         BEGIN
             UPDATE agents SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
         END",
        [],
    )?;

    // Create settings table for app-wide settings
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // Create trigger to update the updated_at timestamp
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS update_app_settings_timestamp 
         AFTER UPDATE ON app_settings 
         FOR EACH ROW
         BEGIN
             UPDATE app_settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
         END",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS mobile_devices (
            id TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            revoked INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS mobile_pairing_codes (
            code TEXT PRIMARY KEY,
            expires_at TEXT NOT NULL,
            claimed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS mobile_sync_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS update_mobile_devices_timestamp
         AFTER UPDATE ON mobile_devices
         FOR EACH ROW
         BEGIN
             UPDATE mobile_devices SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
         END",
        [],
    )?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS update_mobile_sync_settings_timestamp
         AFTER UPDATE ON mobile_sync_settings
         FOR EACH ROW
         BEGIN
             UPDATE mobile_sync_settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
         END",
        [],
    )?;

    Ok(conn)
}

/// List all agents
#[tauri::command]
pub async fn list_agents(db: State<'_, AgentDb>) -> Result<Vec<Agent>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks, created_at, updated_at FROM agents ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let agents = stmt
        .query_map([], |row| {
            Ok(Agent {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                icon: row.get(2)?,
                system_prompt: row.get(3)?,
                default_task: row.get(4)?,
                provider_id: row
                    .get::<_, String>(5)
                    .unwrap_or_else(|_| "claude".to_string()),
                model: row
                    .get::<_, String>(6)
                    .unwrap_or_else(|_| "sonnet".to_string()),
                enable_file_read: row.get::<_, bool>(7).unwrap_or(true),
                enable_file_write: row.get::<_, bool>(8).unwrap_or(true),
                enable_network: row.get::<_, bool>(9).unwrap_or(false),
                hooks: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(agents)
}

/// Create a new agent
#[tauri::command]
pub async fn create_agent(
    db: State<'_, AgentDb>,
    name: String,
    icon: String,
    system_prompt: String,
    default_task: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    enable_file_read: Option<bool>,
    enable_file_write: Option<bool>,
    enable_network: Option<bool>,
    hooks: Option<String>,
) -> Result<Agent, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let provider_id = provider_id.unwrap_or_else(|| "claude".to_string());
    let model = model.unwrap_or_else(|| "sonnet".to_string());
    let enable_file_read = enable_file_read.unwrap_or(true);
    let enable_file_write = enable_file_write.unwrap_or(true);
    let enable_network = enable_network.unwrap_or(false);

    conn.execute(
        "INSERT INTO agents (name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    // Fetch the created agent
    let agent = conn
        .query_row(
            "SELECT id, name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks, created_at, updated_at FROM agents WHERE id = ?1",
            params![id],
            |row| {
                Ok(Agent {
                    id: Some(row.get(0)?),
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    system_prompt: row.get(3)?,
                    default_task: row.get(4)?,
                    provider_id: row
                        .get::<_, String>(5)
                        .unwrap_or_else(|_| "claude".to_string()),
                    model: row.get(6)?,
                    enable_file_read: row.get(7)?,
                    enable_file_write: row.get(8)?,
                    enable_network: row.get(9)?,
                    hooks: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(agent)
}

/// Update an existing agent
#[tauri::command]
pub async fn update_agent(
    db: State<'_, AgentDb>,
    id: i64,
    name: String,
    icon: String,
    system_prompt: String,
    default_task: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    enable_file_read: Option<bool>,
    enable_file_write: Option<bool>,
    enable_network: Option<bool>,
    hooks: Option<String>,
) -> Result<Agent, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let model = model.unwrap_or_else(|| "sonnet".to_string());

    // Build dynamic query based on provided parameters
    let mut query = "UPDATE agents SET name = ?1, icon = ?2, system_prompt = ?3, default_task = ?4, provider_id = COALESCE(?5, provider_id), model = ?6, hooks = ?7".to_string();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(name),
        Box::new(icon),
        Box::new(system_prompt),
        Box::new(default_task),
        Box::new(provider_id),
        Box::new(model),
        Box::new(hooks),
    ];
    let mut param_count = 7;

    if let Some(efr) = enable_file_read {
        param_count += 1;
        query.push_str(&format!(", enable_file_read = ?{}", param_count));
        params_vec.push(Box::new(efr));
    }
    if let Some(efw) = enable_file_write {
        param_count += 1;
        query.push_str(&format!(", enable_file_write = ?{}", param_count));
        params_vec.push(Box::new(efw));
    }
    if let Some(en) = enable_network {
        param_count += 1;
        query.push_str(&format!(", enable_network = ?{}", param_count));
        params_vec.push(Box::new(en));
    }

    param_count += 1;
    query.push_str(&format!(" WHERE id = ?{}", param_count));
    params_vec.push(Box::new(id));

    conn.execute(
        &query,
        rusqlite::params_from_iter(params_vec.iter().map(|p| p.as_ref())),
    )
    .map_err(|e| e.to_string())?;

    // Fetch the updated agent
    let agent = conn
        .query_row(
            "SELECT id, name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks, created_at, updated_at FROM agents WHERE id = ?1",
            params![id],
            |row| {
                Ok(Agent {
                    id: Some(row.get(0)?),
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    system_prompt: row.get(3)?,
                    default_task: row.get(4)?,
                    provider_id: row
                        .get::<_, String>(5)
                        .unwrap_or_else(|_| "claude".to_string()),
                    model: row.get(6)?,
                    enable_file_read: row.get(7)?,
                    enable_file_write: row.get(8)?,
                    enable_network: row.get(9)?,
                    hooks: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(agent)
}

/// Delete an agent
#[tauri::command]
pub async fn delete_agent(db: State<'_, AgentDb>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM agents WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get a single agent by ID
#[tauri::command]
pub async fn get_agent(db: State<'_, AgentDb>, id: i64) -> Result<Agent, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let agent = conn
        .query_row(
            "SELECT id, name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks, created_at, updated_at FROM agents WHERE id = ?1",
            params![id],
            |row| {
                Ok(Agent {
                    id: Some(row.get(0)?),
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    system_prompt: row.get(3)?,
                    default_task: row.get(4)?,
                    provider_id: row
                        .get::<_, String>(5)
                        .unwrap_or_else(|_| "claude".to_string()),
                    model: row.get::<_, String>(6).unwrap_or_else(|_| "sonnet".to_string()),
                    enable_file_read: row.get::<_, bool>(7).unwrap_or(true),
                    enable_file_write: row.get::<_, bool>(8).unwrap_or(true),
                    enable_network: row.get::<_, bool>(9).unwrap_or(false),
                    hooks: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(agent)
}

/// List agent runs (optionally filtered by agent_id)
#[tauri::command]
pub async fn list_agent_runs(
    db: State<'_, AgentDb>,
    agent_id: Option<i64>,
) -> Result<Vec<AgentRun>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let query = if agent_id.is_some() {
        "SELECT id, agent_id, agent_name, agent_icon, provider_id, task, model, project_path, session_id, output, status, pid, process_started_at, created_at, completed_at
         FROM agent_runs WHERE agent_id = ?1 ORDER BY created_at DESC"
    } else {
        "SELECT id, agent_id, agent_name, agent_icon, provider_id, task, model, project_path, session_id, output, status, pid, process_started_at, created_at, completed_at
         FROM agent_runs ORDER BY created_at DESC"
    };

    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;

    let run_mapper = |row: &rusqlite::Row| -> rusqlite::Result<AgentRun> {
        Ok(AgentRun {
            id: Some(row.get(0)?),
            agent_id: row.get(1)?,
            agent_name: row.get(2)?,
            agent_icon: row.get(3)?,
            provider_id: row
                .get::<_, String>(4)
                .unwrap_or_else(|_| "claude".to_string()),
            task: row.get(5)?,
            model: row.get(6)?,
            project_path: row.get(7)?,
            session_id: row.get(8)?,
            output: row
                .get::<_, Option<String>>(9)?
                .filter(|s| !s.is_empty()),
            status: row
                .get::<_, String>(10)
                .unwrap_or_else(|_| "pending".to_string()),
            pid: row
                .get::<_, Option<i64>>(11)
                .ok()
                .flatten()
                .map(|p| p as u32),
            process_started_at: row.get(12)?,
            created_at: row.get(13)?,
            completed_at: row.get(14)?,
        })
    };

    let runs = if let Some(aid) = agent_id {
        stmt.query_map(params![aid], run_mapper)
    } else {
        stmt.query_map(params![], run_mapper)
    }
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

    Ok(runs)
}

/// Get a single agent run by ID
#[tauri::command]
pub async fn get_agent_run(db: State<'_, AgentDb>, id: i64) -> Result<AgentRun, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let run = conn
        .query_row(
            "SELECT id, agent_id, agent_name, agent_icon, provider_id, task, model, project_path, session_id, output, status, pid, process_started_at, created_at, completed_at
             FROM agent_runs WHERE id = ?1",
            params![id],
            |row| {
                Ok(AgentRun {
                    id: Some(row.get(0)?),
                    agent_id: row.get(1)?,
                    agent_name: row.get(2)?,
                    agent_icon: row.get(3)?,
                    provider_id: row
                        .get::<_, String>(4)
                        .unwrap_or_else(|_| "claude".to_string()),
                    task: row.get(5)?,
                    model: row.get(6)?,
                    project_path: row.get(7)?,
                    session_id: row.get(8)?,
                    output: row
                        .get::<_, Option<String>>(9)?
                        .filter(|s| !s.is_empty()),
                    status: row
                        .get::<_, String>(10)
                        .unwrap_or_else(|_| "pending".to_string()),
                    pid: row.get::<_, Option<i64>>(11).ok().flatten().map(|p| p as u32),
                    process_started_at: row.get(12)?,
                    created_at: row.get(13)?,
                    completed_at: row.get(14)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(run)
}

/// Get agent run with real-time metrics from JSONL
#[tauri::command]
pub async fn get_agent_run_with_real_time_metrics(
    db: State<'_, AgentDb>,
    id: i64,
) -> Result<AgentRunWithMetrics, String> {
    let run = get_agent_run(db, id).await?;
    Ok(get_agent_run_with_metrics(run).await)
}

/// List agent runs with real-time metrics from JSONL
#[tauri::command]
pub async fn list_agent_runs_with_metrics(
    db: State<'_, AgentDb>,
    agent_id: Option<i64>,
) -> Result<Vec<AgentRunWithMetrics>, String> {
    let runs = list_agent_runs(db, agent_id).await?;
    let mut runs_with_metrics = Vec::new();

    for run in runs {
        let run_with_metrics = get_agent_run_with_metrics(run).await;
        runs_with_metrics.push(run_with_metrics);
    }

    Ok(runs_with_metrics)
}

fn env_has_value(name: &str) -> bool {
    env::var(name).map(|v| !v.trim().is_empty()).unwrap_or(false)
}

fn env_is_truthy(name: &str) -> bool {
    env::var(name)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn gemini_adc_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".config/gcloud/application_default_credentials.json"));
    }

    if let Ok(appdata) = env::var("APPDATA") {
        paths.push(
            PathBuf::from(appdata)
                .join("gcloud")
                .join("application_default_credentials.json"),
        );
    }

    paths
}

fn gemini_auth_ready() -> bool {
    let api_key_ready = env_has_value("GEMINI_API_KEY") || env_has_value("GOOGLE_API_KEY");

    let vertex_ready = env_is_truthy("GOOGLE_GENAI_USE_VERTEXAI")
        && env_has_value("GOOGLE_CLOUD_PROJECT")
        && (env_has_value("GOOGLE_CLOUD_LOCATION") || env_has_value("GOOGLE_CLOUD_REGION"));

    let adc_ready = gemini_adc_paths().into_iter().any(|path| path.exists());

    api_key_ready || vertex_ready || adc_ready
}

async fn provider_runtime_status(
    app: &AppHandle,
    provider_id: &str,
) -> Result<ProviderRuntimeStatus, String> {
    let mut status = ProviderRuntimeStatus {
        provider_id: provider_id.to_string(),
        installed: false,
        auth_ready: true,
        ready: false,
        detected_binary: None,
        detected_version: None,
        issues: Vec::new(),
        setup_hints: Vec::new(),
    };

    if provider_id == "claude" {
        match find_claude_binary(app) {
            Ok(path) => {
                status.installed = true;
                status.detected_binary = Some(path);
            }
            Err(_) => {
                status.issues.push("Claude CLI is not detected on this system.".to_string());
                status
                    .setup_hints
                    .push("Install Claude Code CLI and ensure `claude` is available in PATH.".to_string());
            }
        }
    } else {
        if let Some(agent) = crate::agent_binary::discover_agent(app, provider_id).await {
            status.installed = true;
            status.detected_binary = Some(agent.binary_path);
            status.detected_version = agent.version;
        } else {
            status.issues.push(format!(
                "Provider '{}' binary is not detected on this system.",
                provider_id
            ));
            status
                .setup_hints
                .push(format!("Install the '{}' CLI and ensure it is available in PATH.", provider_id));
        }
    }

    if provider_id == "gemini" {
        status.auth_ready = gemini_auth_ready();
        if !status.auth_ready {
            status.issues.push("Gemini authentication was not detected.".to_string());
            status.setup_hints.push(
                "Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) before running Gemini tasks."
                    .to_string(),
            );
            status.setup_hints.push(
                "Or configure Vertex auth with `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`."
                    .to_string(),
            );
            status.setup_hints.push(
                "Or run `gcloud auth application-default login` to create ADC credentials."
                    .to_string(),
            );
        }
    }

    status.ready = status.installed && status.auth_ready;
    Ok(status)
}

fn provider_runtime_error(status: &ProviderRuntimeStatus) -> String {
    let mut message = format!(
        "Provider '{}' is not ready for execution.",
        status.provider_id
    );

    if !status.issues.is_empty() {
        message.push_str("\nIssues:");
        for issue in &status.issues {
            message.push_str(&format!("\n- {}", issue));
        }
    }

    if !status.setup_hints.is_empty() {
        message.push_str("\nSuggested fixes:");
        for hint in &status.setup_hints {
            message.push_str(&format!("\n- {}", hint));
        }
    }

    message
}

/// Check runtime readiness for a provider (binary + auth prerequisites).
#[tauri::command]
pub async fn check_provider_runtime(
    app: AppHandle,
    provider_id: String,
) -> Result<ProviderRuntimeStatus, String> {
    provider_runtime_status(&app, &provider_id).await
}

/// Execute a CC agent with streaming output
#[tauri::command]
pub async fn execute_agent(
    app: AppHandle,
    agent_id: i64,
    project_path: String,
    task: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    db: State<'_, AgentDb>,
    registry: State<'_, crate::process::ProcessRegistryState>,
) -> Result<i64, String> {
    tracing::info!("Executing agent {} with task: {}", agent_id, task);

    // Get the agent from database
    let agent = get_agent(db.clone(), agent_id).await?;
    let provider_id = if agent.provider_id.is_empty() {
        "claude".to_string()
    } else {
        agent.provider_id.clone()
    };
    let execution_model = model.unwrap_or(agent.model.clone());
    let initial_session_id = if provider_id == "claude" {
        String::new()
    } else {
        format!("{}-run-{}", provider_id, chrono::Utc::now().timestamp_millis())
    };

    // Fail fast on missing provider runtime prerequisites.
    let runtime_status = provider_runtime_status(&app, &provider_id).await?;
    if !runtime_status.ready {
        return Err(provider_runtime_error(&runtime_status));
    }

    let binary_path = runtime_status
        .detected_binary
        .clone()
        .unwrap_or(resolve_provider_binary(&app, &provider_id).await?);

    // Create .claude/settings.json with agent hooks for Claude providers.
    if provider_id == "claude" && agent.hooks.is_some() {
        let hooks_json = match agent.hooks.as_ref() {
            Some(hooks) => hooks,
            None => {
                tracing::error!("Agent hooks field is None despite is_some() check");
                return Err("Agent hooks unavailable".into());
            }
        };
        let claude_dir = std::path::Path::new(&project_path).join(".claude");
        let settings_path = claude_dir.join("settings.json");

        // Create .claude directory if it doesn't exist
        if !claude_dir.exists() {
            std::fs::create_dir_all(&claude_dir)
                .map_err(|e| format!("Failed to create .claude directory: {}", e))?;
            tracing::info!("Created .claude directory at: {:?}", claude_dir);
        }

        // Check if settings.json already exists
        if !settings_path.exists() {
            // Parse the hooks JSON
            let hooks: serde_json::Value = serde_json::from_str(hooks_json)
                .map_err(|e| format!("Failed to parse agent hooks: {}", e))?;

            // Create a settings object with just the hooks
            let settings = serde_json::json!({
                "hooks": hooks
            });

            // Write the settings file
            let settings_content = serde_json::to_string_pretty(&settings)
                .map_err(|e| format!("Failed to serialize settings: {}", e))?;

            std::fs::write(&settings_path, settings_content)
                .map_err(|e| format!("Failed to write settings.json: {}", e))?;

            tracing::info!(
                "Created settings.json with agent hooks at: {:?}",
                settings_path
            );
        } else {
            tracing::info!("settings.json already exists at: {:?}", settings_path);
        }
    }

    // Create a new run record
    let run_id = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agent_runs (agent_id, agent_name, agent_icon, provider_id, task, model, project_path, session_id, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                agent_id,
                agent.name.clone(),
                agent.icon.clone(),
                provider_id.clone(),
                task.clone(),
                execution_model.clone(),
                project_path.clone(),
                initial_session_id.clone(),
                "",
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    tracing::info!(
        "Running agent '{}' with provider '{}'",
        agent.name, provider_id
    );
    let args = build_provider_args(
        &provider_id,
        &task,
        &execution_model,
        Some(&agent.system_prompt),
        reasoning_effort.as_deref(),
    );

    spawn_agent_system(
        app,
        run_id,
        agent_id,
        agent.name.clone(),
        provider_id,
        binary_path,
        args,
        project_path,
        task,
        execution_model,
        initial_session_id,
        db,
        registry,
    )
    .await
}

async fn resolve_provider_binary(app: &AppHandle, provider_id: &str) -> Result<String, String> {
    if provider_id == "claude" {
        return find_claude_binary(app);
    }

    crate::agent_binary::discover_agent(app, provider_id)
        .await
        .map(|a| a.binary_path)
        .ok_or_else(|| format!("Provider '{}' is not installed or not detected", provider_id))
}

fn build_provider_args(
    provider_id: &str,
    task: &str,
    model: &str,
    system_prompt: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Vec<String> {
    let model = model.trim();
    let has_explicit_model = !model.is_empty() && !model.eq_ignore_ascii_case("default");

    match provider_id {
        "claude" => {
            let mut args = vec![
                "-p".to_string(),
                task.to_string(),
                "--system-prompt".to_string(),
                system_prompt.unwrap_or("").to_string(),
            ];
            if has_explicit_model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args.extend([
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ]);
            args
        }
        "codex" => {
            let mut args = vec!["exec".to_string(), "--json".to_string(), task.to_string()];
            if has_explicit_model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            if let Some(effort) = sanitize_reasoning_effort(reasoning_effort) {
                args.extend([
                    "-c".to_string(),
                    format!("model_reasoning_effort=\"{}\"", effort),
                ]);
            } else if reasoning_effort.is_some() {
                tracing::warn!("Ignoring invalid codex reasoning effort: {:?}", reasoning_effort);
            }
            args
        }
        "aider" => {
            let mut args = vec![
                "--message".to_string(),
                task.to_string(),
                "--yes".to_string(),
            ];
            if has_explicit_model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args
        }
        "gemini" => {
            let mut args = vec![
                "--prompt".to_string(),
                task.to_string(),
                "--approval-mode".to_string(),
                "yolo".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if has_explicit_model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args
        }
        "goose" => {
            let mut args = vec![
                "run".to_string(),
                "--text".to_string(),
                task.to_string(),
                "--no-session".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if has_explicit_model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args
        }
        "opencode" => {
            let mut args = vec!["run".to_string(), task.to_string()];
            if has_explicit_model {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args
        }
        _ => vec![task.to_string()],
    }
}

fn sanitize_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&'static str> {
    match reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
    {
        Some(value) => match value.as_str() {
            "none" => Some("none"),
            "minimal" => Some("minimal"),
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "xhigh" => Some("xhigh"),
            _ => None,
        },
        None => None,
    }
}

fn wrap_as_assistant_text(text: &str) -> String {
    serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{ "type": "text", "text": text }]
        }
    })
    .to_string()
}

fn transform_provider_output(provider_id: &str, line: &str) -> Option<String> {
    match provider_id {
        "claude" => Some(line.to_string()),
        "codex" => crate::commands::codex_transform::transform_codex_line(line),
        _ => {
            // For unknown provider JSON formats, wrap as text unless it's already
            // in Claude-compatible stream shape.
            if let Ok(parsed) = serde_json::from_str::<JsonValue>(line) {
                let has_type = parsed.get("type").and_then(|v| v.as_str()).is_some();
                let has_message_content = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .is_some();
                if has_type && has_message_content {
                    return Some(line.to_string());
                }
            }
            Some(wrap_as_assistant_text(line))
        }
    }
}

/// Creates a system binary command for agent execution
fn create_agent_system_command(
    binary_path: &str,
    args: Vec<String>,
    project_path: &str,
) -> Command {
    let mut cmd = create_command_with_env(binary_path);

    // Add all arguments
    for arg in args {
        cmd.arg(arg);
    }

    cmd.current_dir(project_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd
}

/// Spawn agent using system binary command
async fn spawn_agent_system(
    app: AppHandle,
    run_id: i64,
    agent_id: i64,
    agent_name: String,
    provider_id: String,
    binary_path: String,
    args: Vec<String>,
    project_path: String,
    task: String,
    execution_model: String,
    initial_session_id: String,
    db: State<'_, AgentDb>,
    registry: State<'_, crate::process::ProcessRegistryState>,
) -> Result<i64, String> {
    // Build the command
    let mut cmd = create_agent_system_command(&binary_path, args, &project_path);

    // Spawn the process
    tracing::info!("🚀 Spawning {} system process...", provider_id);
    let mut child = cmd.spawn().map_err(|e| {
        tracing::error!("❌ Failed to spawn {} process: {}", provider_id, e);
        format!("Failed to spawn {}: {}", provider_id, e)
    })?;

    tracing::info!("🔌 Using Stdio::null() for stdin - no input expected");

    // Get the PID and register the process
    let pid = child.id().unwrap_or(0);
    let now = chrono::Utc::now().to_rfc3339();
    tracing::info!(
        "✅ {} process spawned successfully with PID: {}",
        provider_id, pid
    );

    // Update the database with PID and status
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE agent_runs SET status = 'running', pid = ?1, process_started_at = ?2 WHERE id = ?3",
            params![pid as i64, now, run_id],
        ).map_err(|e| e.to_string())?;
        tracing::info!("📝 Updated database with running status and PID");
    }

    // Get stdout and stderr
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;
    tracing::info!("📡 Set up stdout/stderr readers");

    // Create readers
    let stdout_reader = TokioBufReader::new(stdout);
    let stderr_reader = TokioBufReader::new(stderr);

    // Create variables we need for the spawned tasks
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            tracing::error!("Failed to get app data directory: {}", e);
            format!("Failed to get app data directory: {}", e)
        })?;
    let db_path = app_dir.join("agents.db");

    // Shared state for collecting session ID and live output
    let session_id = std::sync::Arc::new(Mutex::new(initial_session_id.clone()));
    let live_output = std::sync::Arc::new(Mutex::new(String::new()));
    let start_time = std::time::Instant::now();

    // Non-Claude providers don't emit a Claude-style init event, so emit one ourselves.
    if provider_id != "claude" {
        let init_line = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "session_id": initial_session_id,
            "provider_id": provider_id,
            "cwd": project_path,
            "model": execution_model,
        })
        .to_string();

        if let Ok(mut output) = live_output.lock() {
            output.push_str(&init_line);
            output.push('\n');
        }

        let _ = registry.0.append_live_output(run_id, &init_line);
        let _ = app.emit(&format!("agent-output:{}", run_id), &init_line);
        let _ = app.emit("agent-output", &init_line);
    }

    // Spawn tasks to read stdout and stderr
    let app_handle = app.clone();
    let session_id_clone = session_id.clone();
    let live_output_clone = live_output.clone();
    let registry_clone = registry.0.clone();
    let first_output = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
        provider_id != "claude",
    ));
    let first_output_clone = first_output.clone();
    let db_path_for_stdout = db_path.clone(); // Clone the db_path for the stdout task
    let provider_stdout = provider_id.clone();

    let stdout_task = tokio::spawn(async move {
        tracing::info!("📖 Starting to read {} stdout...", provider_stdout);
        let mut lines = stdout_reader.lines();
        let mut line_count = 0;

        while let Ok(Some(line)) = lines.next_line().await {
            line_count += 1;

            // Log first output
            if !first_output_clone.load(std::sync::atomic::Ordering::Relaxed) {
                tracing::info!(
                    "🎉 First output received from {} process! Line: {}",
                    provider_stdout,
                    line
                );
                first_output_clone.store(true, std::sync::atomic::Ordering::Relaxed);
            }

            if line_count <= 5 {
                tracing::info!("stdout[{}]: {}", line_count, line);
            } else {
                tracing::debug!("stdout[{}]: {}", line_count, line);
            }

            let Some(emitted_line) = transform_provider_output(&provider_stdout, &line) else {
                continue;
            };

            if let Ok(mut output) = live_output_clone.lock() {
                output.push_str(&emitted_line);
                output.push('\n');
            }

            let _ = registry_clone.append_live_output(run_id, &emitted_line);

            // Extract session ID from JSONL output
            if provider_stdout == "claude" {
                if let Ok(json) = serde_json::from_str::<JsonValue>(&emitted_line) {
                // Claude Code uses "session_id" (underscore), not "sessionId"
                    if json.get("type").and_then(|t| t.as_str()) == Some("system")
                        && json.get("subtype").and_then(|s| s.as_str()) == Some("init")
                    {
                        if let Some(sid) = json.get("session_id").and_then(|s| s.as_str()) {
                            if let Ok(mut current_session_id) = session_id_clone.lock() {
                                if current_session_id.is_empty() {
                                    *current_session_id = sid.to_string();
                                    tracing::info!("🔑 Extracted session ID: {}", sid);

                                    if let Ok(conn) = Connection::open(&db_path_for_stdout) {
                                        match conn.execute(
                                            "UPDATE agent_runs SET session_id = ?1 WHERE id = ?2",
                                            params![sid, run_id],
                                        ) {
                                            Ok(rows) => {
                                                if rows > 0 {
                                                    tracing::info!("✅ Updated agent run {} with session ID immediately", run_id);
                                                }
                                            }
                                            Err(e) => {
                                                tracing::error!("❌ Failed to update session ID immediately: {}", e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Emit the line to the frontend with run_id for isolation
            let _ = app_handle.emit(&format!("agent-output:{}", run_id), &emitted_line);
            // Also emit to the generic event for backward compatibility
            let _ = app_handle.emit("agent-output", &emitted_line);
        }

        tracing::info!(
            "📖 Finished reading {} stdout. Total lines: {}",
            provider_stdout, line_count
        );
    });

    let app_handle_stderr = app.clone();
    let first_error = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let first_error_clone = first_error.clone();
    let provider_stderr = provider_id.clone();
    let live_output_stderr = live_output.clone();
    let registry_stderr = registry.0.clone();

    let stderr_task = tokio::spawn(async move {
        tracing::info!("📖 Starting to read {} stderr...", provider_stderr);
        let mut lines = stderr_reader.lines();
        let mut error_count = 0;

        while let Ok(Some(line)) = lines.next_line().await {
            error_count += 1;

            // Log first error
            if !first_error_clone.load(std::sync::atomic::Ordering::Relaxed) {
                tracing::warn!(
                    "⚠️ First error output from {} process! Line: {}",
                    provider_stderr, line
                );
                first_error_clone.store(true, std::sync::atomic::Ordering::Relaxed);
            }

            tracing::error!("stderr[{}]: {}", error_count, line);

            if provider_stderr == "claude" {
                let _ = app_handle_stderr.emit(&format!("agent-error:{}", run_id), &line);
                let _ = app_handle_stderr.emit("agent-error", &line);
                continue;
            }

            let wrapped = wrap_as_assistant_text(&line);
            if let Ok(mut output) = live_output_stderr.lock() {
                output.push_str(&wrapped);
                output.push('\n');
            }
            let _ = registry_stderr.append_live_output(run_id, &wrapped);
            let _ = app_handle_stderr.emit(&format!("agent-output:{}", run_id), &wrapped);
            let _ = app_handle_stderr.emit("agent-output", &wrapped);
            let _ = app_handle_stderr.emit(&format!("agent-error:{}", run_id), &line);
            let _ = app_handle_stderr.emit("agent-error", &line);
        }

        if error_count > 0 {
            tracing::warn!(
                "📖 Finished reading {} stderr. Total error lines: {}",
                provider_stderr, error_count
            );
        } else {
            tracing::info!("📖 Finished reading {} stderr. No errors.", provider_stderr);
        }
    });

    // Register in registry using PID-based tracking; the wait task retains the child handle.
    registry
        .0
        .register_sidecar_process(
            run_id,
            agent_id,
            agent_name,
            pid,
            project_path.clone(),
            task.clone(),
            execution_model.clone(),
        )
        .map_err(|e| format!("Failed to register process: {}", e))?;
    tracing::info!("📋 Registered process in registry");

    let db_path_for_monitor = db_path.clone(); // Clone for the monitor task
    let provider_monitor = provider_id.clone();
    let initial_session_id_monitor = if let Ok(sid) = session_id.lock() {
        sid.clone()
    } else {
        String::new()
    };
    let live_output_monitor = live_output.clone();
    let registry_monitor = registry.0.clone();
    let mut child_for_wait = child;

    // Monitor process status and wait for completion
    tokio::spawn(async move {
        tracing::info!("🕐 Starting process monitoring...");

        // Wait for first output with timeout
        for i in 0..300 {
            // 30 seconds (300 * 100ms)
            if first_output.load(std::sync::atomic::Ordering::Relaxed) {
                tracing::info!(
                    "✅ Output detected after {}ms, continuing normal execution",
                    i * 100
                );
                break;
            }

            if i == 299 {
                tracing::warn!(
                    "⏰ TIMEOUT: No output from {} process after 30 seconds",
                    provider_monitor
                );
                tracing::warn!("💡 This usually means:");
                tracing::warn!("   1. Provider process is waiting for user input");
                tracing::warn!("   3. Provider failed to initialize but didn't report an error");
                tracing::warn!("   4. Network connectivity issues");
                tracing::warn!("   5. Authentication issues (API key not found/invalid)");

                // Process timed out - kill it via PID
                tracing::warn!(
                    "🔍 Process likely stuck waiting for input, attempting to kill PID: {}",
                    pid
                );
                let kill_result = std::process::Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .output();

                match kill_result {
                    Ok(output) if output.status.success() => {
                        tracing::warn!("🔍 Successfully sent TERM signal to process");
                    }
                    Ok(_) => {
                        tracing::warn!("🔍 Failed to kill process with TERM, trying KILL");
                        let _ = std::process::Command::new("kill")
                            .arg("-KILL")
                            .arg(pid.to_string())
                            .output();
                    }
                    Err(e) => {
                        tracing::warn!("🔍 Error killing process: {}", e);
                    }
                }

                // Update database
                if let Ok(conn) = Connection::open(&db_path_for_monitor) {
                    let final_output = live_output_monitor
                        .lock()
                        .map(|o| o.clone())
                        .unwrap_or_default();
                    let _ = conn.execute(
                        "UPDATE agent_runs
                         SET output = ?1, status = 'failed', completed_at = CURRENT_TIMESTAMP
                         WHERE id = ?2 AND status = 'running'",
                        params![final_output, run_id],
                    );
                }

                let _ = registry_monitor.unregister_process(run_id);
                let _ = app.emit("agent-complete", false);
                let _ = app.emit(&format!("agent-complete:{}", run_id), false);
                return;
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        // Wait for reading tasks to complete
        tracing::info!("⏳ Waiting for stdout/stderr reading to complete...");
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let duration_ms = start_time.elapsed().as_millis() as i64;
        tracing::info!("⏱️ Process execution took {} ms", duration_ms);
        let process_success = match child_for_wait.wait().await {
            Ok(status) => {
                tracing::info!(
                    "✅ {} exited with status: {}",
                    provider_monitor, status
                );
                status.success()
            }
            Err(e) => {
                tracing::error!("❌ Failed to wait for {} process: {}", provider_monitor, e);
                false
            }
        };

        // Get the session ID that was extracted
        let extracted_session_id = if let Ok(sid) = session_id.lock() {
            sid.clone()
        } else {
            String::new()
        };
        let final_session_id = if extracted_session_id.is_empty() {
            initial_session_id_monitor
        } else {
            extracted_session_id
        };
        let final_output = live_output_monitor
            .lock()
            .map(|o| o.clone())
            .unwrap_or_default();

        // Wait for process completion and update status
        tracing::info!("✅ {} process execution monitoring complete", provider_monitor);

        // Update the run record with session/output and mark as completed.
        if let Ok(conn) = Connection::open(&db_path_for_monitor) {
            tracing::info!(
                "🔄 Updating database with final session ID: {}",
                final_session_id
            );
            match conn.execute(
                "UPDATE agent_runs
                 SET session_id = ?1,
                     output = ?2,
                     status = ?3,
                     completed_at = CURRENT_TIMESTAMP
                 WHERE id = ?4 AND status = 'running'",
                params![
                    final_session_id,
                    final_output,
                    if process_success { "completed" } else { "failed" },
                    run_id
                ],
            ) {
                Ok(rows_affected) => {
                    if rows_affected > 0 {
                        tracing::info!("✅ Successfully updated agent run {} metadata", run_id);
                    } else {
                        tracing::warn!("⚠️ No rows affected when updating agent run {}", run_id);
                    }
                }
                Err(e) => {
                    tracing::error!("❌ Failed to update agent run {} metadata: {}", run_id, e);
                }
            }
        } else {
            tracing::error!(
                "❌ Failed to open database to update session ID for run {}",
                run_id
            );
        }

        // Cleanup will be handled by the cleanup_finished_processes function
        let _ = registry_monitor.unregister_process(run_id);
        let _ = app.emit("agent-complete", process_success);
        let _ = app.emit(&format!("agent-complete:{}", run_id), process_success);
    });

    Ok(run_id)
}

/// List all currently running agent sessions
#[tauri::command]
pub async fn list_running_sessions(
    db: State<'_, AgentDb>,
    registry: State<'_, crate::process::ProcessRegistryState>,
) -> Result<Vec<AgentRun>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // First get all running sessions from the database
    let mut stmt = conn.prepare(
        "SELECT id, agent_id, agent_name, agent_icon, provider_id, task, model, project_path, session_id, output, status, pid, process_started_at, created_at, completed_at
         FROM agent_runs WHERE status = 'running' ORDER BY process_started_at DESC"
    ).map_err(|e| e.to_string())?;

    let mut runs = stmt
        .query_map([], |row| {
            Ok(AgentRun {
                id: Some(row.get(0)?),
                agent_id: row.get(1)?,
                agent_name: row.get(2)?,
                agent_icon: row.get(3)?,
                provider_id: row
                    .get::<_, String>(4)
                    .unwrap_or_else(|_| "claude".to_string()),
                task: row.get(5)?,
                model: row.get(6)?,
                project_path: row.get(7)?,
                session_id: row.get(8)?,
                output: row
                    .get::<_, Option<String>>(9)?
                    .filter(|s| !s.is_empty()),
                status: row
                    .get::<_, String>(10)
                    .unwrap_or_else(|_| "pending".to_string()),
                pid: row
                    .get::<_, Option<i64>>(11)
                    .ok()
                    .flatten()
                    .map(|p| p as u32),
                process_started_at: row.get(12)?,
                created_at: row.get(13)?,
                completed_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    drop(stmt);
    drop(conn);

    // Cross-check with the process registry to ensure accuracy
    // Get actually running processes from the registry
    let registry_processes = registry.0.get_running_agent_processes()?;
    let registry_run_ids: std::collections::HashSet<i64> =
        registry_processes.iter().map(|p| p.run_id).collect();

    // Filter out any database entries that aren't actually running in the registry
    // This handles cases where processes crashed without updating the database
    runs.retain(|run| {
        if let Some(run_id) = run.id {
            registry_run_ids.contains(&run_id)
        } else {
            false
        }
    });

    Ok(runs)
}

/// Kill a running agent session
#[tauri::command]
pub async fn kill_agent_session(
    app: AppHandle,
    db: State<'_, AgentDb>,
    registry: State<'_, crate::process::ProcessRegistryState>,
    run_id: i64,
) -> Result<bool, String> {
    tracing::info!("Attempting to kill agent session {}", run_id);

    // First try to kill using the process registry
    let killed_via_registry = match registry.0.kill_process(run_id).await {
        Ok(success) => {
            if success {
                tracing::info!("Successfully killed process {} via registry", run_id);
                true
            } else {
                tracing::warn!("Process {} not found in registry", run_id);
                false
            }
        }
        Err(e) => {
            tracing::warn!("Failed to kill process {} via registry: {}", run_id, e);
            false
        }
    };

    // If registry kill didn't work, try fallback with PID from database
    if !killed_via_registry {
        let pid_result = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT pid FROM agent_runs WHERE id = ?1 AND status = 'running'",
                params![run_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|e| e.to_string())?
        };

        if let Some(pid) = pid_result {
            tracing::info!("Attempting fallback kill for PID {} from database", pid);
            let _ = registry.0.kill_process_by_pid(run_id, pid as u32)?;
        }
    }

    // Update the database to mark as cancelled
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let live_output = registry.0.get_live_output(run_id).unwrap_or_default();
    let updated = conn.execute(
        "UPDATE agent_runs
         SET status = 'cancelled',
             output = CASE WHEN ?2 != '' THEN ?2 ELSE output END,
             completed_at = CURRENT_TIMESTAMP
         WHERE id = ?1 AND status = 'running'",
        params![run_id, live_output],
    ).map_err(|e| e.to_string())?;

    // Emit cancellation event with run_id for proper isolation
    let _ = app.emit(&format!("agent-cancelled:{}", run_id), true);

    Ok(updated > 0 || killed_via_registry)
}

/// Get the status of a specific agent session
#[tauri::command]
pub async fn get_session_status(
    db: State<'_, AgentDb>,
    run_id: i64,
) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    match conn.query_row(
        "SELECT status FROM agent_runs WHERE id = ?1",
        params![run_id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(status) => Ok(Some(status)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Cleanup finished processes and update their status
#[tauri::command]
pub async fn cleanup_finished_processes(db: State<'_, AgentDb>) -> Result<Vec<i64>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Get all running processes
    let mut stmt = conn
        .prepare("SELECT id, pid FROM agent_runs WHERE status = 'running' AND pid IS NOT NULL")
        .map_err(|e| e.to_string())?;

    let running_processes = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    drop(stmt);

    let mut cleaned_up = Vec::new();

    for (run_id, pid) in running_processes {
        // Check if the process is still running
        let is_running = if cfg!(target_os = "windows") {
            // On Windows, use tasklist to check if process exists
            match std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {}", pid)])
                .args(["/FO", "CSV"])
                .output()
            {
                Ok(output) => {
                    let output_str = String::from_utf8_lossy(&output.stdout);
                    output_str.lines().count() > 1 // Header + process line if exists
                }
                Err(_) => false,
            }
        } else {
            // On Unix-like systems, use kill -0 to check if process exists
            match std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
            {
                Ok(output) => output.status.success(),
                Err(_) => false,
            }
        };

        if !is_running {
            // Process has finished, update status
            let updated = conn.execute(
                "UPDATE agent_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![run_id],
            ).map_err(|e| e.to_string())?;

            if updated > 0 {
                cleaned_up.push(run_id);
                tracing::info!(
                    "Marked agent run {} as completed (PID {} no longer running)",
                    run_id, pid
                );
            }
        }
    }

    Ok(cleaned_up)
}

/// Get live output from a running process
#[tauri::command]
pub async fn get_live_session_output(
    registry: State<'_, crate::process::ProcessRegistryState>,
    run_id: i64,
) -> Result<String, String> {
    registry.0.get_live_output(run_id)
}

/// Get real-time output for a running session by reading its JSONL file with live output fallback
#[tauri::command]
pub async fn get_session_output(
    db: State<'_, AgentDb>,
    registry: State<'_, crate::process::ProcessRegistryState>,
    run_id: i64,
) -> Result<String, String> {
    // Get the session information
    let run = get_agent_run(db, run_id).await?;

    // Persisted output is the most reliable source across restarts/providers.
    if let Some(output) = &run.output {
        if !output.is_empty() {
            return Ok(output.clone());
        }
    }

    // Non-Claude providers don't write ~/.claude JSONL session files.
    if run.provider_id != "claude" {
        return registry.0.get_live_output(run_id);
    }

    // If no session ID yet, try to get live output from registry
    if run.session_id.is_empty() {
        let live_output = registry.0.get_live_output(run_id)?;
        if !live_output.is_empty() {
            return Ok(live_output);
        }
        return Ok(String::new());
    }

    // Get the Claude directory
    let claude_dir = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude");

    // Find the correct project directory by searching for the session file
    let projects_dir = claude_dir.join("projects");

    // Check if projects directory exists
    if !projects_dir.exists() {
        tracing::error!("Projects directory not found at: {:?}", projects_dir);
        return Err("Projects directory not found".to_string());
    }

    // Search for the session file in all project directories
    let mut session_file_path = None;
    tracing::info!(
        "Searching for session file {} in all project directories",
        run.session_id
    );

    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = path.file_name().unwrap_or_default().to_string_lossy();
                tracing::debug!("Checking project directory: {}", dir_name);

                let potential_session_file = path.join(format!("{}.jsonl", run.session_id));
                if potential_session_file.exists() {
                    tracing::info!("Found session file at: {:?}", potential_session_file);
                    session_file_path = Some(potential_session_file);
                    break;
                } else {
                    tracing::debug!("Session file not found in: {}", dir_name);
                }
            }
        }
    } else {
        tracing::error!("Failed to read projects directory");
    }

    // If we found the session file, read it
    if let Some(session_path) = session_file_path {
        match tokio::fs::read_to_string(&session_path).await {
            Ok(content) => Ok(content),
            Err(e) => {
                tracing::error!(
                    "Failed to read session file {}: {}",
                    session_path.display(),
                    e
                );
                // Fallback to live output if file read fails
                let live_output = registry.0.get_live_output(run_id)?;
                Ok(live_output)
            }
        }
    } else {
        // If session file not found, try the old method as fallback
        tracing::warn!(
            "Session file not found for {}, trying legacy method",
            run.session_id
        );
        match read_session_jsonl(&run.session_id, &run.project_path).await {
            Ok(content) => Ok(content),
            Err(_) => {
                // Final fallback to live output
                let live_output = registry.0.get_live_output(run_id)?;
                Ok(live_output)
            }
        }
    }
}

/// Stream real-time session output by watching the JSONL file
#[tauri::command]
pub async fn stream_session_output(
    app: AppHandle,
    db: State<'_, AgentDb>,
    run_id: i64,
) -> Result<(), String> {
    // Get the session information
    let run = get_agent_run(db, run_id).await?;

    // Non-Claude providers stream directly via agent-output events.
    if run.provider_id != "claude" {
        return Ok(());
    }

    // If no session ID yet, can't stream
    if run.session_id.is_empty() {
        return Err("Session not started yet".to_string());
    }

    let session_id = run.session_id.clone();
    let project_path = run.project_path.clone();

    // Spawn a task to monitor the file
    tokio::spawn(async move {
        let claude_dir = match dirs::home_dir() {
            Some(home) => home.join(".claude").join("projects"),
            None => return,
        };

        let encoded_project = project_path.replace('/', "-");
        let project_dir = claude_dir.join(&encoded_project);
        let session_file = project_dir.join(format!("{}.jsonl", session_id));

        let mut last_size = 0u64;

        // Monitor file changes continuously while session is running
        loop {
            if session_file.exists() {
                if let Ok(metadata) = tokio::fs::metadata(&session_file).await {
                    let current_size = metadata.len();

                    if current_size > last_size {
                        // File has grown, read new content
                        if let Ok(content) = tokio::fs::read_to_string(&session_file).await {
                            let _ = app
                                .emit("session-output-update", &format!("{}:{}", run_id, content));
                        }
                        last_size = current_size;
                    }
                }
            } else {
                // If session file doesn't exist yet, keep waiting
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                continue;
            }

            // Check if the session is still running by querying the database
            // If the session is no longer running, stop streaming
            if let Ok(conn) = rusqlite::Connection::open(
                app.path()
                    .app_data_dir()
                    .expect("Failed to get app data dir")
                    .join("agents.db"),
            ) {
                if let Ok(status) = conn.query_row(
                    "SELECT status FROM agent_runs WHERE id = ?1",
                    rusqlite::params![run_id],
                    |row| row.get::<_, String>(0),
                ) {
                    if status != "running" {
                        tracing::debug!("Session {} is no longer running, stopping stream", run_id);
                        break;
                    }
                } else {
                    // If we can't query the status, assume it's still running
                    tracing::debug!(
                        "Could not query session status for {}, continuing stream",
                        run_id
                    );
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        tracing::debug!("Stopped streaming for session {}", run_id);
    });

    Ok(())
}

/// Export a single agent to JSON format
#[tauri::command]
pub async fn export_agent(db: State<'_, AgentDb>, id: i64) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Fetch the agent
    let agent = conn
        .query_row(
            "SELECT name, icon, system_prompt, default_task, provider_id, model, hooks FROM agents WHERE id = ?1",
            params![id],
            |row| {
                Ok(serde_json::json!({
                    "name": row.get::<_, String>(0)?,
                    "icon": row.get::<_, String>(1)?,
                    "system_prompt": row.get::<_, String>(2)?,
                    "default_task": row.get::<_, Option<String>>(3)?,
                    "provider_id": row.get::<_, String>(4)?,
                    "model": row.get::<_, String>(5)?,
                    "hooks": row.get::<_, Option<String>>(6)?
                }))
            },
        )
        .map_err(|e| format!("Failed to fetch agent: {}", e))?;

    // Create the export wrapper
    let export_data = serde_json::json!({
        "version": 1,
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "agent": agent
    });

    // Convert to pretty JSON string
    serde_json::to_string_pretty(&export_data)
        .map_err(|e| format!("Failed to serialize agent: {}", e))
}

/// Export agent to file with native dialog
#[tauri::command]
pub async fn export_agent_to_file(
    db: State<'_, AgentDb>,
    id: i64,
    file_path: String,
) -> Result<(), String> {
    // Get the JSON data
    let json_data = export_agent(db, id).await?;

    // Write to file
    std::fs::write(&file_path, json_data).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

/// Get the stored Claude binary path from settings
#[tauri::command]
pub async fn get_claude_binary_path(db: State<'_, AgentDb>) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    match conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'claude_binary_path'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(path) => Ok(Some(path)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Failed to get Claude binary path: {}", e)),
    }
}

/// Set the Claude binary path in settings
#[tauri::command]
pub async fn set_claude_binary_path(db: State<'_, AgentDb>, path: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    if crate::claude_binary::is_disallowed_claude_path(&path) {
        return Err(
            "Selected path points to a GUI app bundle. Please select the Claude CLI binary."
                .to_string(),
        );
    }

    // Validate that the path exists and is executable
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    // Check if it's executable (on Unix systems)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&path_buf)
            .map_err(|e| format!("Failed to read file metadata: {}", e))?;
        let permissions = metadata.permissions();
        if permissions.mode() & 0o111 == 0 {
            return Err(format!("File is not executable: {}", path));
        }
    }

    // Insert or update the setting
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('claude_binary_path', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        params![path],
    )
    .map_err(|e| format!("Failed to save Claude binary path: {}", e))?;

    Ok(())
}

/// List all available Claude installations on the system
#[tauri::command]
pub async fn list_claude_installations(
    _app: AppHandle,
) -> Result<Vec<crate::claude_binary::ClaudeInstallation>, String> {
    let installations = crate::claude_binary::discover_claude_installations();

    if installations.is_empty() {
        return Err("No Claude Code installations found on the system".to_string());
    }

    Ok(installations)
}

/// Helper function to create a tokio Command with proper environment variables
/// This ensures commands like Claude can find Node.js and other dependencies
fn create_command_with_env(program: &str) -> Command {
    // Convert std::process::Command to tokio::process::Command
    let _std_cmd = crate::claude_binary::create_command_with_env(program);

    // Create a new tokio Command from the program path
    let mut tokio_cmd = Command::new(program);

    // Inherit full environment so all providers receive auth/config vars.
    for (key, value) in std::env::vars() {
        tokio_cmd.env(&key, &value);
    }

    // Add NVM support if the program is in an NVM directory
    if program.contains("/.nvm/versions/node/") {
        if let Some(node_bin_dir) = std::path::Path::new(program).parent() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let node_bin_str = node_bin_dir.to_string_lossy();
            if !current_path.contains(&node_bin_str.as_ref()) {
                let new_path = format!("{}:{}", node_bin_str, current_path);
                tokio_cmd.env("PATH", new_path);
            }
        }
    }

    // Ensure PATH contains common Homebrew locations
    if let Ok(existing_path) = std::env::var("PATH") {
        let mut paths: Vec<&str> = existing_path.split(':').collect();
        for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].iter() {
            if !paths.contains(p) {
                paths.push(p);
            }
        }
        let joined = paths.join(":");
        tokio_cmd.env("PATH", joined);
    } else {
        tokio_cmd.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    }

    tokio_cmd
}

/// Import an agent from JSON data
#[tauri::command]
pub async fn import_agent(db: State<'_, AgentDb>, json_data: String) -> Result<Agent, String> {
    // Parse the JSON data
    let export_data: AgentExport =
        serde_json::from_str(&json_data).map_err(|e| format!("Invalid JSON format: {}", e))?;

    // Validate version
    if export_data.version != 1 {
        return Err(format!(
            "Unsupported export version: {}. This version of the app only supports version 1.",
            export_data.version
        ));
    }

    let agent_data = export_data.agent;
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Check if an agent with the same name already exists
    let existing_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agents WHERE name = ?1",
            params![agent_data.name],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    // If agent with same name exists, append a suffix
    let final_name = if existing_count > 0 {
        format!("{} (Imported)", agent_data.name)
    } else {
        agent_data.name
    };

    // Create the agent
    conn.execute(
        "INSERT INTO agents (name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, 0, ?7)",
        params![
            final_name,
            agent_data.icon,
            agent_data.system_prompt,
            agent_data.default_task,
            agent_data.provider_id,
            agent_data.model,
            agent_data.hooks
        ],
    )
    .map_err(|e| format!("Failed to create agent: {}", e))?;

    let id = conn.last_insert_rowid();

    // Fetch the created agent
    let agent = conn
        .query_row(
            "SELECT id, name, icon, system_prompt, default_task, provider_id, model, enable_file_read, enable_file_write, enable_network, hooks, created_at, updated_at FROM agents WHERE id = ?1",
            params![id],
            |row| {
                Ok(Agent {
                    id: Some(row.get(0)?),
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    system_prompt: row.get(3)?,
                    default_task: row.get(4)?,
                    provider_id: row
                        .get::<_, String>(5)
                        .unwrap_or_else(|_| "claude".to_string()),
                    model: row.get(6)?,
                    enable_file_read: row.get(7)?,
                    enable_file_write: row.get(8)?,
                    enable_network: row.get(9)?,
                    hooks: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(|e| format!("Failed to fetch created agent: {}", e))?;

    Ok(agent)
}

/// Import agent from file
#[tauri::command]
pub async fn import_agent_from_file(
    db: State<'_, AgentDb>,
    file_path: String,
) -> Result<Agent, String> {
    // Read the file
    let mut json_data =
        std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Normalize potential BOM and whitespace issues
    if json_data.starts_with('\u{feff}') {
        json_data = json_data.trim_start_matches('\u{feff}').to_string();
    }
    // Also trim leading/trailing whitespace to avoid parse surprises
    json_data = json_data.trim().to_string();

    // Import the agent
    import_agent(db, json_data).await
}

// GitHub Agent Import functionality

/// Represents a GitHub agent file from the API
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubAgentFile {
    pub name: String,
    pub path: String,
    pub download_url: String,
    pub size: i64,
    pub sha: String,
}

/// Represents the GitHub API response for directory contents
#[derive(Debug, Deserialize)]
struct GitHubApiResponse {
    name: String,
    path: String,
    sha: String,
    size: i64,
    download_url: Option<String>,
    #[serde(rename = "type")]
    file_type: String,
}

/// Fetch list of agents from GitHub repository
#[tauri::command]
pub async fn fetch_github_agents() -> Result<Vec<GitHubAgentFile>, String> {
    tracing::info!("Fetching agents from GitHub repository...");

    let client = reqwest::Client::new();
    let url = "https://api.github.com/repos/FlourishingHumanityCorporation/opcode/contents/cc_agents";

    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "codeinterfacex-App")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch from GitHub: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API error ({}): {}", status, error_text));
    }

    let api_files: Vec<GitHubApiResponse> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    // Filter only .codeinterfacex.json agent files
    let agent_files: Vec<GitHubAgentFile> = api_files
        .into_iter()
        .filter(|f| f.name.ends_with(".codeinterfacex.json") && f.file_type == "file")
        .filter_map(|f| {
            f.download_url.map(|download_url| GitHubAgentFile {
                name: f.name,
                path: f.path,
                download_url,
                size: f.size,
                sha: f.sha,
            })
        })
        .collect();

    tracing::info!("Found {} agents on GitHub", agent_files.len());
    Ok(agent_files)
}

/// Fetch and preview a specific agent from GitHub
#[tauri::command]
pub async fn fetch_github_agent_content(download_url: String) -> Result<AgentExport, String> {
    tracing::info!("Fetching agent content from: {}", download_url);

    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .header("Accept", "application/json")
        .header("User-Agent", "codeinterfacex-App")
        .send()
        .await
        .map_err(|e| format!("Failed to download agent: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download agent: HTTP {}",
            response.status()
        ));
    }

    let json_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Parse and validate the agent data
    let export_data: AgentExport = serde_json::from_str(&json_text)
        .map_err(|e| format!("Invalid agent JSON format: {}", e))?;

    // Validate version
    if export_data.version != 1 {
        return Err(format!(
            "Unsupported agent version: {}",
            export_data.version
        ));
    }

    Ok(export_data)
}

/// Import an agent directly from GitHub
#[tauri::command]
pub async fn import_agent_from_github(
    db: State<'_, AgentDb>,
    download_url: String,
) -> Result<Agent, String> {
    tracing::info!("Importing agent from GitHub: {}", download_url);

    // First, fetch the agent content
    let export_data = fetch_github_agent_content(download_url).await?;

    // Convert to JSON string and use existing import logic
    let json_data = serde_json::to_string(&export_data)
        .map_err(|e| format!("Failed to serialize agent data: {}", e))?;

    // Import using existing function
    import_agent(db, json_data).await
}

/// Load agent session history from JSONL file
/// Similar to provider-session history loading, but searches across all project directories
#[tauri::command]
pub async fn load_agent_session_history(
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    tracing::info!("Loading agent session history for session: {}", session_id);

    let claude_dir = dirs::home_dir()
        .ok_or("Failed to get home directory")?
        .join(".claude");

    let projects_dir = claude_dir.join("projects");

    if !projects_dir.exists() {
        tracing::error!("Projects directory not found at: {:?}", projects_dir);
        return Err("Projects directory not found".to_string());
    }

    // Search for the session file in all project directories
    let mut session_file_path = None;
    tracing::info!(
        "Searching for session file {} in all project directories",
        session_id
    );

    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = path.file_name().unwrap_or_default().to_string_lossy();
                tracing::debug!("Checking project directory: {}", dir_name);

                let potential_session_file = path.join(format!("{}.jsonl", session_id));
                if potential_session_file.exists() {
                    tracing::info!("Found session file at: {:?}", potential_session_file);
                    session_file_path = Some(potential_session_file);
                    break;
                } else {
                    tracing::debug!("Session file not found in: {}", dir_name);
                }
            }
        }
    } else {
        tracing::error!("Failed to read projects directory");
    }

    if let Some(session_path) = session_file_path {
        let file = std::fs::File::open(&session_path)
            .map_err(|e| format!("Failed to open session file: {}", e))?;

        let reader = BufReader::new(file);
        let mut messages = Vec::new();

        for line in reader.lines() {
            if let Ok(line) = line {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                    messages.push(json);
                }
            }
        }

        Ok(messages)
    } else {
        Err(format!("Session file not found: {}", session_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_provider_args_claude_contains_expected_flags() {
        let args = build_provider_args(
            "claude",
            "test task",
            "sonnet",
            Some("system prompt here"),
            None,
        );
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "test task");
        assert!(args.contains(&"--system-prompt".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
    }

    #[test]
    fn build_provider_args_codex_contains_exec_json() {
        let args = build_provider_args("codex", "refactor code", "gpt-5.3-codex", None, None);
        assert_eq!(
            args,
            vec![
                "exec".to_string(),
                "--json".to_string(),
                "refactor code".to_string(),
                "--model".to_string(),
                "gpt-5.3-codex".to_string()
            ]
        );
    }

    #[test]
    fn build_provider_args_codex_includes_reasoning_effort() {
        let args = build_provider_args(
            "codex",
            "refactor code",
            "gpt-5.3-codex",
            None,
            Some("xhigh"),
        );
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"xhigh\"".to_string()));
    }

    #[test]
    fn build_provider_args_codex_ignores_invalid_reasoning_effort() {
        let args = build_provider_args(
            "codex",
            "refactor code",
            "gpt-5.3-codex",
            None,
            Some("extra_high"),
        );
        assert!(!args.contains(&"-c".to_string()));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("model_reasoning_effort")));
    }

    #[test]
    fn build_provider_args_goose_uses_non_interactive_stream_mode() {
        let args = build_provider_args("goose", "summarize repo", "gpt-5", None, None);
        assert_eq!(args[0], "run");
        assert_eq!(args[1], "--text");
        assert!(args.contains(&"--no-session".to_string()));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--model".to_string()));
    }

    #[test]
    fn build_provider_args_opencode_uses_run_command() {
        let args = build_provider_args("opencode", "fix failing tests", "gpt-5", None, None);
        assert_eq!(args[0], "run");
        assert_eq!(args[1], "fix failing tests");
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
    }

    #[test]
    fn transform_provider_output_wraps_plain_text_for_generic_provider() {
        let wrapped = transform_provider_output("gemini", "hello world").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&wrapped).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["message"]["content"][0]["text"], "hello world");
    }

    #[test]
    fn transform_provider_output_passes_claude_json_line_through() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#;
        let transformed = transform_provider_output("claude", line).unwrap();
        assert_eq!(line, transformed);
    }
}
