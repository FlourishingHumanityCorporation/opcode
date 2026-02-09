use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::commands::agents::AgentDb;

use super::protocol::{PROTOCOL_VERSION, VERSION_HEADER};

#[derive(Debug, Clone)]
pub struct AuthenticatedDevice {
    pub device_id: String,
    pub device_name: String,
}

pub fn verify_protocol_version(headers: &HeaderMap) -> Result<(), String> {
    let Some(raw_header) = headers.get(VERSION_HEADER) else {
        return Err(format!("Missing {} header", VERSION_HEADER));
    };

    let parsed = raw_header
        .to_str()
        .map_err(|_| format!("Invalid {} header", VERSION_HEADER))?
        .parse::<u8>()
        .map_err(|_| format!("Invalid {} header", VERSION_HEADER))?;

    if parsed != PROTOCOL_VERSION {
        return Err(format!(
            "Unsupported protocol version {} (expected {})",
            parsed, PROTOCOL_VERSION
        ));
    }

    Ok(())
}

pub fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

pub fn hash_token(raw_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn generate_pairing_code() -> String {
    let compact = Uuid::new_v4().simple().to_string();
    compact.chars().take(6).collect::<String>().to_uppercase()
}

pub fn generate_opaque_token() -> String {
    format!("opc_{}_{}", Uuid::new_v4(), Uuid::new_v4().simple())
}

pub fn authenticate_token(app: &AppHandle, token: &str) -> Result<AuthenticatedDevice, String> {
    let db = app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| format!("Failed to lock database: {}", error))?;

    let token_hash = hash_token(token);

    let mut statement = conn
        .prepare(
            "SELECT id, device_name, revoked
             FROM mobile_devices
             WHERE token_hash = ?1
             LIMIT 1",
        )
        .map_err(|error| format!("Failed to prepare auth query: {}", error))?;

    let row = statement
        .query_row([token_hash], |row| {
            let id: String = row.get(0)?;
            let device_name: String = row.get(1)?;
            let revoked: i64 = row.get(2)?;
            Ok((id, device_name, revoked))
        })
        .map_err(|_| "Authentication failed".to_string())?;

    if row.2 != 0 {
        return Err("Device has been revoked".to_string());
    }

    conn.execute(
        "UPDATE mobile_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [row.0.clone()],
    )
    .map_err(|error| format!("Failed to update last_seen_at: {}", error))?;

    Ok(AuthenticatedDevice {
        device_id: row.0,
        device_name: row.1,
    })
}

pub fn parse_expiration(expiration_raw: &str) -> Result<DateTime<Utc>, String> {
    let parsed = DateTime::parse_from_rfc3339(expiration_raw)
        .map_err(|error| format!("Invalid expiration timestamp: {}", error))?;
    Ok(parsed.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn extract_bearer_token_handles_valid_value() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer token-value"));

        let token = extract_bearer_token(&headers).expect("token should be parsed");
        assert_eq!(token, "token-value");
    }

    #[test]
    fn extract_bearer_token_rejects_empty_value() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer   "));

        assert!(extract_bearer_token(&headers).is_none());
    }

    #[test]
    fn hash_token_is_deterministic() {
        let hash_a = hash_token("token-123");
        let hash_b = hash_token("token-123");
        let hash_c = hash_token("token-456");

        assert_eq!(hash_a, hash_b);
        assert_ne!(hash_a, hash_c);
    }
}
