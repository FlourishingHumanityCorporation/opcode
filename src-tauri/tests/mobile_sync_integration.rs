use opcode_lib::mobile_sync::protocol::PROTOCOL_VERSION;
use opcode_lib::mobile_sync::state_cache::MobileSyncCache;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

#[tokio::test]
async fn mobile_sync_cache_snapshot_and_event_sequence_increases() {
    let cache = MobileSyncCache::new();

    let snapshot = cache
        .publish_snapshot(json!({
            "tabs": [],
            "activeTabId": null,
        }))
        .await;

    assert_eq!(snapshot.version, PROTOCOL_VERSION);
    assert_eq!(snapshot.sequence, 1);

    let event = cache.publish_event(
        "workspace.state_changed",
        json!({
            "activeTabId": null,
            "tabCount": 0,
        }),
    );

    assert_eq!(event.version, PROTOCOL_VERSION);
    assert_eq!(event.sequence, 3);
    assert_eq!(cache.current_sequence(), 3);
}

#[tokio::test]
async fn mobile_sync_cache_emits_snapshot_updated_and_tracks_latest_snapshot() {
    let cache = MobileSyncCache::new();
    let mut receiver = cache.subscribe();

    let snapshot = cache
        .publish_snapshot(json!({
            "tabs": [],
            "activeTabId": "workspace-1",
        }))
        .await;

    let envelope = receiver.recv().await.expect("snapshot.updated envelope");
    assert_eq!(envelope.version, PROTOCOL_VERSION);
    assert_eq!(envelope.event_type, "snapshot.updated");
    assert_eq!(envelope.payload["sequence"], json!(snapshot.sequence));
    assert_eq!(envelope.sequence, snapshot.sequence + 1);

    let latest = cache.latest_snapshot().await.expect("latest snapshot");
    assert_eq!(latest.sequence, snapshot.sequence);
    assert_eq!(latest.state["activeTabId"], json!("workspace-1"));
}

#[tokio::test]
async fn mobile_sync_cache_reports_subscriber_lag_when_sequence_gap_grows() {
    let cache = MobileSyncCache::new();
    let mut receiver = cache.subscribe();

    for index in 0..700_u64 {
        cache.publish_event(
            "workspace.state_changed",
            json!({
                "sequenceMarker": index,
            }),
        );
    }

    match receiver.recv().await {
        Err(RecvError::Lagged(skipped)) => {
            assert!(skipped > 0);
        }
        other => panic!("expected lagged receiver error, got {:?}", other),
    }
}

#[tokio::test]
async fn mobile_sync_cache_connected_client_count_tracks_lifecycle() {
    let cache = MobileSyncCache::new();
    assert_eq!(cache.connected_clients(), 0);

    cache.increment_clients();
    cache.increment_clients();
    assert_eq!(cache.connected_clients(), 2);

    cache.decrement_clients();
    assert_eq!(cache.connected_clients(), 1);
}
