use opcode_lib::mobile_sync::protocol::PROTOCOL_VERSION;
use opcode_lib::mobile_sync::state_cache::MobileSyncCache;
use serde_json::json;

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
