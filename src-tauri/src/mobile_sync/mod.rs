pub mod actions;
pub mod auth;
pub mod protocol;
pub mod server;
pub mod state_cache;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::commands::agents::AgentDb;

use self::{
    auth::{generate_pairing_code, generate_opaque_token, hash_token},
    protocol::{PairingPayloadV1, PublishEventInput, SnapshotV1, PROTOCOL_VERSION},
    state_cache::MobileSyncCache,
};

#[derive(Clone)]
pub struct MobileSyncServiceState {
    pub cache: MobileSyncCache,
    pub bind_host: String,
    pub port: u16,
    pub public_host: Arc<RwLock<String>>,
    server_started: Arc<AtomicBool>,
}

impl MobileSyncServiceState {
    pub fn new(bind_host: impl Into<String>, port: u16) -> Self {
        Self {
            cache: MobileSyncCache::new(),
            bind_host: bind_host.into(),
            port,
            public_host: Arc::new(RwLock::new("127.0.0.1".to_string())),
            server_started: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn mark_server_started(&self) -> bool {
        self.server_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn mark_server_stopped(&self) {
        self.server_started.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncStatus {
    pub version: u8,
    pub enabled: bool,
    pub bind_host: String,
    pub public_host: String,
    pub port: u16,
    pub base_url: String,
    pub ws_url: String,
    pub tailscale_ip: Option<String>,
    pub connected_clients: usize,
    pub sequence: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncDevice {
    pub id: String,
    pub device_name: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked: bool,
}

pub fn bootstrap_mobile_sync(app: AppHandle, state: MobileSyncServiceState) {
    let enabled = read_mobile_sync_setting(&app, "enabled")
        .ok()
        .flatten()
        .map(|value| value == "true")
        .unwrap_or(false);

    let public_host = read_mobile_sync_setting(&app, "public_host")
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());

    {
        let mut host_guard = state.public_host.blocking_write();
        *host_guard = public_host;
    }

    state.cache.set_enabled(enabled);
    if enabled {
        ensure_server_running(app, state);
    }
}

pub fn ensure_server_running(app: AppHandle, state: MobileSyncServiceState) {
    if !state.mark_server_started() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(error) = server::run_mobile_sync_server(app.clone(), state.clone()).await {
            tracing::error!("mobile sync server failed: {}", error);
            state.mark_server_stopped();
        }
    });
}

pub fn read_mobile_sync_setting(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let db = app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| format!("Failed to lock database: {}", error))?;

    let mut statement = conn
        .prepare("SELECT value FROM mobile_sync_settings WHERE key = ?1 LIMIT 1")
        .map_err(|error| format!("Failed to prepare setting query: {}", error))?;

    let result = statement.query_row([key], |row| row.get::<_, String>(0));

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to read setting '{}': {}", key, error)),
    }
}

pub fn write_mobile_sync_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let db = app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| format!("Failed to lock database: {}", error))?;

    conn.execute(
        "INSERT INTO mobile_sync_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        [key, value],
    )
    .map_err(|error| format!("Failed to save setting '{}': {}", key, error))?;

    Ok(())
}

fn tailscale_ip() -> Option<String> {
    let output = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())?
        .to_string();

    Some(value)
}

async fn build_status(state: &MobileSyncServiceState) -> MobileSyncStatus {
    let public_host = state.public_host.read().await.clone();
    let base_url = format!("http://{}:{}", public_host, state.port);
    MobileSyncStatus {
        version: PROTOCOL_VERSION,
        enabled: state.cache.is_enabled(),
        bind_host: state.bind_host.clone(),
        public_host,
        port: state.port,
        ws_url: format!("{}/mobile/v1/ws", base_url.replace("http://", "ws://")),
        base_url,
        tailscale_ip: tailscale_ip(),
        connected_clients: state.cache.connected_clients(),
        sequence: state.cache.current_sequence(),
    }
}

#[tauri::command]
pub async fn mobile_sync_get_status(
    state: State<'_, MobileSyncServiceState>,
) -> Result<MobileSyncStatus, String> {
    Ok(build_status(&state).await)
}

#[tauri::command]
pub async fn mobile_sync_set_enabled(
    app: AppHandle,
    state: State<'_, MobileSyncServiceState>,
    enabled: bool,
) -> Result<MobileSyncStatus, String> {
    write_mobile_sync_setting(&app, "enabled", if enabled { "true" } else { "false" })?;
    state.cache.set_enabled(enabled);
    if enabled {
        ensure_server_running(app, state.inner().clone());
    }
    Ok(build_status(&state).await)
}

#[tauri::command]
pub async fn mobile_sync_set_public_host(
    app: AppHandle,
    state: State<'_, MobileSyncServiceState>,
    public_host: String,
) -> Result<MobileSyncStatus, String> {
    let trimmed = public_host.trim();
    if trimmed.is_empty() {
        return Err("Public host cannot be empty".to_string());
    }

    write_mobile_sync_setting(&app, "public_host", trimmed)?;
    {
        let mut host_guard = state.public_host.write().await;
        *host_guard = trimmed.to_string();
    }

    Ok(build_status(&state).await)
}

#[tauri::command]
pub async fn mobile_sync_publish_snapshot(
    state: State<'_, MobileSyncServiceState>,
    snapshot_state: serde_json::Value,
) -> Result<SnapshotV1, String> {
    Ok(state.cache.publish_snapshot(snapshot_state).await)
}

#[tauri::command]
pub async fn mobile_sync_publish_events(
    state: State<'_, MobileSyncServiceState>,
    events: Vec<PublishEventInput>,
) -> Result<Vec<protocol::EventEnvelopeV1>, String> {
    let envelopes = events
        .iter()
        .map(|event| state.cache.publish_event(&event.event_type, event.payload.clone()))
        .collect::<Vec<_>>();

    Ok(envelopes)
}

#[tauri::command]
pub async fn mobile_sync_start_pairing(
    app: AppHandle,
    state: State<'_, MobileSyncServiceState>,
) -> Result<PairingPayloadV1, String> {
    let pair_code = generate_pairing_code();
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();

    {
        let db = app.state::<AgentDb>();
        let conn = db
            .0
            .lock()
            .map_err(|error| format!("Failed to lock database: {}", error))?;

        conn.execute(
            "INSERT INTO mobile_pairing_codes (code, expires_at, claimed) VALUES (?1, ?2, 0)",
            [pair_code.clone(), expires_at.clone()],
        )
        .map_err(|error| format!("Failed to create pairing code: {}", error))?;
    }

    let host = state.public_host.read().await.clone();
    Ok(PairingPayloadV1 {
        version: PROTOCOL_VERSION,
        pair_code,
        host,
        port: state.port,
        expires_at,
    })
}

#[tauri::command]
pub async fn mobile_sync_list_devices(app: AppHandle) -> Result<Vec<MobileSyncDevice>, String> {
    let db = app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| format!("Failed to lock database: {}", error))?;

    let mut statement = conn
        .prepare(
            "SELECT id, device_name, created_at, last_seen_at, revoked
             FROM mobile_devices
             ORDER BY created_at DESC",
        )
        .map_err(|error| format!("Failed to prepare device query: {}", error))?;

    let devices = statement
        .query_map([], |row| {
            Ok(MobileSyncDevice {
                id: row.get(0)?,
                device_name: row.get(1)?,
                created_at: row.get(2)?,
                last_seen_at: row.get(3)?,
                revoked: row.get::<_, i64>(4).unwrap_or(0) != 0,
            })
        })
        .map_err(|error| format!("Failed to query devices: {}", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect devices: {}", error))?;

    Ok(devices)
}

#[tauri::command]
pub async fn mobile_sync_revoke_device(app: AppHandle, device_id: String) -> Result<(), String> {
    let db = app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| format!("Failed to lock database: {}", error))?;

    conn.execute(
        "UPDATE mobile_devices SET revoked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [device_id],
    )
    .map_err(|error| format!("Failed to revoke device: {}", error))?;

    Ok(())
}

pub fn create_device_token(app: &AppHandle, device_name: &str) -> Result<(String, String), String> {
    let device_id = Uuid::new_v4().to_string();
    let raw_token = generate_opaque_token();
    let token_hash = hash_token(&raw_token);

    let db = app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| format!("Failed to lock database: {}", error))?;

    conn.execute(
        "INSERT INTO mobile_devices (id, device_name, token_hash, revoked)
         VALUES (?1, ?2, ?3, 0)",
        [device_id.clone(), device_name.to_string(), token_hash],
    )
    .map_err(|error| format!("Failed to insert mobile device: {}", error))?;

    Ok((device_id, raw_token))
}
