use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
pub const VERSION_HEADER: &str = "x-codeinterfacex-sync-version";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotV1 {
    pub version: u8,
    pub sequence: u64,
    pub generated_at: String,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelopeV1 {
    pub version: u8,
    pub sequence: u64,
    pub event_type: String,
    pub generated_at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequestV1 {
    pub version: u8,
    pub action_id: String,
    pub action_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResultV1 {
    pub version: u8,
    pub action_id: String,
    pub status: String,
    pub sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayloadV1 {
    pub version: u8,
    pub pair_code: String,
    pub host: String,
    pub port: u16,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairClaimRequest {
    pub pair_code: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairClaimResponse {
    pub version: u8,
    pub device_id: String,
    pub token: String,
    pub base_url: String,
    pub ws_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRevokeRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsQuery {
    pub since: Option<u64>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishEventInput {
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_parity_event_envelope_v1() {
        let fixture_raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../packages/mobile-sync-protocol/fixtures/event-envelope-v1.json"
        ));

        let parsed_fixture: EventEnvelopeV1 =
            serde_json::from_str(fixture_raw).expect("fixture must deserialize");

        assert_eq!(parsed_fixture.version, PROTOCOL_VERSION);
        assert_eq!(parsed_fixture.sequence, 42);
        assert_eq!(parsed_fixture.event_type, "workspace.updated");

        let serialized = serde_json::to_value(parsed_fixture).expect("must serialize");
        assert_eq!(serialized["eventType"], "workspace.updated");
        assert_eq!(serialized["payload"]["workspaceId"], "workspace-123");
    }
}
