use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{
    extract::{Query, State as AxumState},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;

use crate::commands::agents::AgentDb;

use super::actions::dispatch_action_to_desktop;
use super::auth::{
    authenticate_token, extract_bearer_token, parse_expiration, verify_protocol_version,
};
use super::protocol::{
    ActionRequestV1, ActionResultV1, DeviceRevokeRequest, PairClaimRequest, PairClaimResponse,
    PairingPayloadV1, WsQuery, PROTOCOL_VERSION,
};
use super::{create_device_token, MobileSyncServiceState};

#[derive(Clone)]
struct MobileServerAppState {
    app: AppHandle,
    service: MobileSyncServiceState,
}

pub async fn run_mobile_sync_server(
    app: AppHandle,
    service: MobileSyncServiceState,
) -> Result<(), Box<dyn std::error::Error>> {
    let bind_host = service.bind_host.clone();
    let port = service.port;
    let state = MobileServerAppState { app, service };

    let router = Router::new()
        .route("/mobile/v1/health", get(health_handler))
        .route("/mobile/v1/snapshot", get(snapshot_handler))
        .route("/mobile/v1/ws", get(websocket_handler))
        .route("/mobile/v1/action", post(action_handler))
        .route("/mobile/v1/pair/start", post(pair_start_handler))
        .route("/mobile/v1/pair/claim", post(pair_claim_handler))
        .route("/mobile/v1/device/revoke", post(device_revoke_handler))
        .with_state(state);

    let listener = TcpListener::bind(format!("{}:{}", bind_host, port)).await?;
    log::info!("mobile sync server listening on {}:{}", bind_host, port);
    axum::serve(listener, router).await?;
    Ok(())
}

fn api_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(json!({
            "success": false,
            "error": message.into(),
        })),
    )
}

fn require_enabled(state: &MobileServerAppState) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if state.service.cache.is_enabled() {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Mobile sync is disabled",
        ))
    }
}

fn verify_version(headers: &HeaderMap) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    verify_protocol_version(headers)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))
}

fn authenticate_request(
    app: &AppHandle,
    headers: &HeaderMap,
) -> Result<super::auth::AuthenticatedDevice, (StatusCode, Json<serde_json::Value>)> {
    verify_version(headers)?;

    let token = extract_bearer_token(headers)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Missing bearer token"))?;

    authenticate_token(app, &token).map_err(|error| api_error(StatusCode::UNAUTHORIZED, error))
}

async fn health_handler(
    AxumState(state): AxumState<MobileServerAppState>,
) -> Json<serde_json::Value> {
    Json(json!({
        "success": true,
        "data": {
            "version": PROTOCOL_VERSION,
            "enabled": state.service.cache.is_enabled(),
            "sequence": state.service.cache.current_sequence(),
            "connectedClients": state.service.cache.connected_clients(),
        }
    }))
}

async fn snapshot_handler(
    headers: HeaderMap,
    AxumState(state): AxumState<MobileServerAppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_enabled(&state)?;
    let _device = authenticate_request(&state.app, &headers)?;

    let snapshot = match state.service.cache.latest_snapshot().await {
        Some(snapshot) => snapshot,
        None => {
            let snapshot = state
                .service
                .cache
                .publish_snapshot(json!({
                    "tabs": [],
                    "activeTabId": null,
                }))
                .await;
            snapshot
        }
    };

    Ok(Json(json!({
        "success": true,
        "data": snapshot,
    })))
}

async fn action_handler(
    headers: HeaderMap,
    AxumState(state): AxumState<MobileServerAppState>,
    Json(request): Json<ActionRequestV1>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_enabled(&state)?;
    let device = authenticate_request(&state.app, &headers)?;

    if request.version != PROTOCOL_VERSION {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            format!(
                "Request version {} does not match protocol {}",
                request.version, PROTOCOL_VERSION
            ),
        ));
    }

    dispatch_action_to_desktop(&state.app, &request)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;

    let envelope = state.service.cache.publish_event(
        "mobile.action.requested",
        json!({
            "actionId": request.action_id,
            "actionType": request.action_type,
            "deviceId": device.device_id,
            "deviceName": device.device_name,
        }),
    );

    let result = ActionResultV1 {
        version: PROTOCOL_VERSION,
        action_id: request.action_id,
        status: "accepted".to_string(),
        sequence: envelope.sequence,
        error: None,
        payload: None,
    };

    Ok(Json(json!({
        "success": true,
        "data": result,
    })))
}

async fn pair_start_handler(
    headers: HeaderMap,
    AxumState(state): AxumState<MobileServerAppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    verify_version(&headers)?;
    require_enabled(&state)?;

    let pair_code = super::auth::generate_pairing_code();
    let expires_at = (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();

    {
        let db = state.app.state::<AgentDb>();
        let conn = db
            .0
            .lock()
            .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

        conn.execute(
            "INSERT INTO mobile_pairing_codes (code, expires_at, claimed) VALUES (?1, ?2, 0)",
            [pair_code.clone(), expires_at.clone()],
        )
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }

    let host = state.service.public_host.read().await.clone();
    let payload = PairingPayloadV1 {
        version: PROTOCOL_VERSION,
        pair_code,
        host,
        port: state.service.port,
        expires_at,
    };

    Ok(Json(json!({
        "success": true,
        "data": payload,
    })))
}

async fn pair_claim_handler(
    headers: HeaderMap,
    AxumState(state): AxumState<MobileServerAppState>,
    Json(request): Json<PairClaimRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    verify_version(&headers)?;
    require_enabled(&state)?;

    let now = Utc::now();

    {
        let db = state.app.state::<AgentDb>();
        let conn = db
            .0
            .lock()
            .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

        let mut statement = conn
            .prepare(
                "SELECT expires_at, claimed FROM mobile_pairing_codes WHERE code = ?1 LIMIT 1",
            )
            .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

        let (expires_at_raw, claimed): (String, i64) = statement
            .query_row([request.pair_code.clone()], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| api_error(StatusCode::UNAUTHORIZED, "Invalid pairing code"))?;

        if claimed != 0 {
            return Err(api_error(StatusCode::UNAUTHORIZED, "Pairing code already used"));
        }

        let expires_at =
            parse_expiration(&expires_at_raw).map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
        if expires_at <= now {
            return Err(api_error(StatusCode::UNAUTHORIZED, "Pairing code expired"));
        }

        conn.execute(
            "UPDATE mobile_pairing_codes SET claimed = 1 WHERE code = ?1",
            [request.pair_code.clone()],
        )
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }

    let (device_id, token) = create_device_token(&state.app, &request.device_name)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;

    let host = state.service.public_host.read().await.clone();
    let base_url = format!("http://{}:{}", host, state.service.port);
    let response = PairClaimResponse {
        version: PROTOCOL_VERSION,
        device_id,
        token,
        base_url: format!("{}/mobile/v1", base_url),
        ws_url: format!("ws://{}:{}/mobile/v1/ws", host, state.service.port),
    };

    Ok(Json(json!({
        "success": true,
        "data": response,
    })))
}

async fn device_revoke_handler(
    headers: HeaderMap,
    AxumState(state): AxumState<MobileServerAppState>,
    Json(request): Json<DeviceRevokeRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_enabled(&state)?;
    let _device = authenticate_request(&state.app, &headers)?;

    let db = state.app.state::<AgentDb>();
    let conn = db
        .0
        .lock()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    conn.execute(
        "UPDATE mobile_devices SET revoked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [request.device_id],
    )
    .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(Json(json!({
        "success": true,
        "data": true,
    })))
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    AxumState(state): AxumState<MobileServerAppState>,
) -> Response {
    if let Err(error) = require_enabled(&state) {
        return error.into_response();
    }

    if let Err(error) = authenticate_request(&state.app, &headers) {
        return error.into_response();
    }

    ws.on_upgrade(move |socket| websocket_loop(socket, state, query.since.unwrap_or(0)))
}

async fn websocket_loop(socket: WebSocket, state: MobileServerAppState, since: u64) {
    let service = state.service.clone();
    service.cache.increment_clients();

    let (mut sender, mut receiver) = socket.split();
    let mut event_receiver = service.cache.subscribe();
    let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(10));

    if since.saturating_add(1) < service.cache.current_sequence() {
        let resync = super::protocol::EventEnvelopeV1 {
            version: PROTOCOL_VERSION,
            sequence: service.cache.current_sequence(),
            event_type: "sync.resnapshot_required".to_string(),
            generated_at: Utc::now().to_rfc3339(),
            payload: json!({
                "reason": "sequence_gap",
                "since": since,
            }),
        };

        let message = serde_json::to_string(&resync).unwrap_or_else(|_| "{}".to_string());
        if sender.send(Message::Text(message.into())).await.is_err() {
            service.cache.decrement_clients();
            return;
        }
    }

    loop {
        tokio::select! {
            client_message = receiver.next() => {
                match client_message {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event_message = event_receiver.recv() => {
                match event_message {
                    Ok(event) => {
                        let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                        if sender.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let resync = super::protocol::EventEnvelopeV1 {
                            version: PROTOCOL_VERSION,
                            sequence: service.cache.current_sequence(),
                            event_type: "sync.resnapshot_required".to_string(),
                            generated_at: Utc::now().to_rfc3339(),
                            payload: json!({
                                "reason": "subscriber_lagged",
                            }),
                        };
                        let payload = serde_json::to_string(&resync).unwrap_or_else(|_| "{}".to_string());
                        if sender.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = heartbeat_interval.tick() => {
                let heartbeat = super::protocol::EventEnvelopeV1 {
                    version: PROTOCOL_VERSION,
                    sequence: service.cache.current_sequence(),
                    event_type: "sync.heartbeat".to_string(),
                    generated_at: Utc::now().to_rfc3339(),
                    payload: json!({ "ok": true }),
                };

                let payload = serde_json::to_string(&heartbeat).unwrap_or_else(|_| "{}".to_string());
                if sender.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
        }
    }

    service.cache.decrement_clients();
}
