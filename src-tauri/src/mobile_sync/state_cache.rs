use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc,
};

use chrono::Utc;
use serde_json::Value;
use tokio::sync::{broadcast, RwLock};

use super::protocol::{EventEnvelopeV1, SnapshotV1, PROTOCOL_VERSION};

#[derive(Clone)]
pub struct MobileSyncCache {
    sequence: Arc<AtomicU64>,
    enabled: Arc<AtomicBool>,
    connected_clients: Arc<AtomicUsize>,
    snapshot: Arc<RwLock<Option<SnapshotV1>>>,
    event_tx: broadcast::Sender<EventEnvelopeV1>,
}

impl MobileSyncCache {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(512);
        Self {
            sequence: Arc::new(AtomicU64::new(0)),
            enabled: Arc::new(AtomicBool::new(false)),
            connected_clients: Arc::new(AtomicUsize::new(0)),
            snapshot: Arc::new(RwLock::new(None)),
            event_tx,
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn current_sequence(&self) -> u64 {
        self.sequence.load(Ordering::Relaxed)
    }

    fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn connected_clients(&self) -> usize {
        self.connected_clients.load(Ordering::Relaxed)
    }

    pub fn increment_clients(&self) {
        self.connected_clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn decrement_clients(&self) {
        self.connected_clients.fetch_sub(1, Ordering::Relaxed);
    }

    pub async fn latest_snapshot(&self) -> Option<SnapshotV1> {
        self.snapshot.read().await.clone()
    }

    pub async fn publish_snapshot(&self, state: Value) -> SnapshotV1 {
        let snapshot = SnapshotV1 {
            version: PROTOCOL_VERSION,
            sequence: self.next_sequence(),
            generated_at: Utc::now().to_rfc3339(),
            state,
        };

        {
            let mut guard = self.snapshot.write().await;
            *guard = Some(snapshot.clone());
        }

        let _ = self.publish_event(
            "snapshot.updated",
            serde_json::json!({
                "sequence": snapshot.sequence,
            }),
        );

        snapshot
    }

    pub fn publish_event(&self, event_type: &str, payload: Value) -> EventEnvelopeV1 {
        let envelope = EventEnvelopeV1 {
            version: PROTOCOL_VERSION,
            sequence: self.next_sequence(),
            event_type: event_type.to_string(),
            generated_at: Utc::now().to_rfc3339(),
            payload,
        };

        let _ = self.event_tx.send(envelope.clone());
        envelope
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelopeV1> {
        self.event_tx.subscribe()
    }
}

impl Default for MobileSyncCache {
    fn default() -> Self {
        Self::new()
    }
}
