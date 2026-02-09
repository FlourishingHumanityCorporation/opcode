use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::protocol::ActionRequestV1;

pub fn dispatch_action_to_desktop(app: &AppHandle, request: &ActionRequestV1) -> Result<(), String> {
    app.emit(
        "mobile-action-requested",
        json!({
            "actionId": request.action_id,
            "actionType": request.action_type,
            "payload": request.payload,
        }),
    )
    .map_err(|error| format!("Failed to dispatch mobile action: {}", error))
}
