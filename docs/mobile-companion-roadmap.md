# Opcode Mobile Companion Roadmap

## Purpose

Build a proper mobile app that mirrors the **current live desktop state** of Opcode, including active workspaces, tabs, terminals, and session streams.

This roadmap replaces the current "separate web mode" mental model with a desktop-hosted state service and a native mobile companion client.

## Product Goal

When a user opens the mobile app, they should see the same active state as the desktop app in near real time and be able to interact with it safely.

## Scope

### In scope

1. Live desktop state snapshot and realtime updates.
2. Mobile read and write actions against desktop state.
3. Secure pairing and device authorization.
4. iOS-first mobile app.
5. Background reconnect and session resume behavior.

### Out of scope (initially)

1. Full parity for every desktop-only settings panel.
2. Offline execution while desktop is unavailable.
3. Public internet exposure without private network or relay controls.

## Current Constraints

1. Existing `opcode-web` is a separate runtime and does not mirror in-memory desktop state.
2. Current remote flow favors access to data and web endpoints, not direct live desktop UI/session continuity.
3. Mobile UX needs a dedicated interaction model for smaller screens and touch input.

## Success Criteria

1. Mobile app displays desktop state within 1 second of connect.
2. State changes on desktop appear on mobile within 300 ms median.
3. Terminal/session input from mobile reaches desktop and echoes output reliably.
4. Reconnect restores session view without losing context.
5. Pairing and access control are explicit, revocable, and auditable.

## Target Architecture

### 1. Desktop State Service (authoritative)

1. Runs inside desktop Opcode process.
2. Exposes:
   1. Snapshot endpoint for initial sync.
   2. Realtime event stream for incremental updates.
   3. Action endpoint for mobile commands.
3. Owns versioned state schema and event protocol.

### 2. Sync Protocol

1. Transport:
   1. WebSocket for realtime events and action acks.
   2. HTTPS endpoint for snapshot bootstrap.
2. Message categories:
   1. `snapshot`
   2. `event`
   3. `action_request`
   4. `action_result`
   5. `error`
3. Ordering:
   1. Monotonic sequence numbers.
   2. Heartbeat and missed-sequence recovery.
   3. Snapshot fallback when drift is detected.

### 3. Mobile Companion App

1. iOS native shell (SwiftUI) or Tauri mobile shell (decision at Phase 0 exit).
2. Renders desktop-derived models:
   1. Workspace tree and active workspace.
   2. Tab order and active tab.
   3. Terminal panes and stream output.
   4. Provider session stream status.
3. Sends user actions to desktop service:
   1. Switch workspace/tab.
   2. Send prompt/input.
   3. Start/stop/resume session.
   4. Terminal input and resize hints.

### 4. Security Model

1. Device pairing via one-time token or QR issued by desktop.
2. All mobile actions scoped to paired device identity.
3. Session revocation in desktop UI.
4. Optional network guardrails:
   1. Tailnet-only access default.
   2. Optional relay mode later.

## Delivery Phases

## Phase 0: Discovery and Protocol Spec (1-2 weeks)

### Deliverables

1. State inventory of desktop runtime objects to sync.
2. Versioned protocol document (snapshot and event schema).
3. Security and pairing design doc.
4. Build-vs-buy decision for mobile shell (SwiftUI vs Tauri mobile).

### Exit criteria

1. Protocol v1 approved.
2. Mobile shell decision finalized.
3. Threat model reviewed.

## Phase 1: Desktop Sync Core (2-3 weeks)

### Deliverables

1. Desktop state aggregator module.
2. Snapshot endpoint (`/sync/snapshot` or equivalent command route).
3. WebSocket realtime stream (`/sync/ws`).
4. Sequence tracking, heartbeat, and resync logic.
5. Structured logging for sync lifecycle.

### Exit criteria

1. Desktop emits deterministic events for tab/workspace/session changes.
2. Snapshot + events reproduce current desktop state in a test harness.

## Phase 2: Secure Pairing and Device Management (1-2 weeks)

### Deliverables

1. Pairing token/QR issuance UI in desktop app.
2. Paired-device registry (local encrypted storage).
3. Action authorization middleware.
4. Device revoke and rotate controls.

### Exit criteria

1. Unpaired device cannot access sync or actions.
2. Revoked device loses access immediately.

## Phase 3: Mobile MVP Client (3-5 weeks)

### Deliverables

1. Mobile app shell with connect/pair flow.
2. Snapshot bootstrap + realtime updates.
3. Core mirrored views:
   1. Workspace and tab list.
   2. Active terminal output.
   3. Session stream timeline.
4. Core actions:
   1. Switch context.
   2. Send input/prompt.
   3. Start/stop/resume session.

### Exit criteria

1. User can continue active desktop work from mobile.
2. Reconnect after app background recovers same live context.

## Phase 4: Reliability and UX Hardening (2-3 weeks)

### Deliverables

1. Conflict policy for simultaneous desktop+mobile actions.
2. Retry/queue policy for transient network interruptions.
3. Performance tuning for large output streams.
4. Mobile-optimized terminal interaction primitives.

### Exit criteria

1. No data corruption under concurrent usage.
2. Stable behavior under packet loss and reconnect storms.

## Phase 5: Beta Rollout and GA (2-4 weeks)

### Deliverables

1. Internal dogfood beta.
2. External closed beta.
3. Telemetry dashboards and alerting.
4. Release checklist and support playbook.

### Exit criteria

1. Reliability SLOs met for 2+ weeks in beta.
2. Critical bug backlog near zero.

## Technical Design Detail

### State Model v1 (minimum)

1. `app`: version, host info, uptime.
2. `workspaces`: ids, names, active workspace id.
3. `tabs`: per workspace order, active tab id.
4. `panes`: terminal/session pane layout state.
5. `provider_sessions`: status, run ids, progress metadata.
6. `terminals`: stream cursor, output chunks, pending input.
7. `notifications`: attention and completion signals.

### Event Types v1

1. `workspace.updated`
2. `tab.activated`
3. `tab.reordered`
4. `pane.layout_changed`
5. `terminal.output_appended`
6. `terminal.input_applied`
7. `provider_session.status_changed`
8. `provider_session.output_appended`
9. `sync.heartbeat`
10. `sync.resnapshot_required`

### Action Types v1

1. `workspace.activate`
2. `tab.activate`
3. `provider_session.execute`
4. `provider_session.resume`
5. `provider_session.cancel`
6. `terminal.write`
7. `terminal.resize_hint`

## Testing Strategy

### Unit tests

1. State reducer consistency and deterministic event emission.
2. Sequence ordering and resync logic.
3. Auth checks and device-revocation edge cases.

### Integration tests

1. Snapshot parity against live desktop state.
2. Event-stream replay reconstructs expected state.
3. Concurrent desktop+mobile action consistency.

### E2E tests

1. Pairing flow success and rejection paths.
2. Realtime mirror of workspace/tab/session changes.
3. Terminal input/output roundtrip from mobile.
4. Reconnect and restore after mobile background/foreground.

### Manual QA scenarios

1. High-volume terminal output.
2. Multiple paired devices at once.
3. Desktop restart while mobile connected.
4. Device revoke mid-session.

## Observability and Ops

1. Metrics:
   1. Sync latency p50/p95.
   2. Disconnect and reconnect rates.
   3. Action failure rates by type.
   4. Snapshot size and frequency.
2. Logs:
   1. Pairing lifecycle.
   2. Auth failures.
   3. Sequence drift and resync events.
3. Alerts:
   1. Elevated sync error rates.
   2. Persistent reconnect loops.
   3. Auth anomaly spikes.

## Risk Register and Mitigations

1. Risk: protocol churn slows client development.
   1. Mitigation: strict versioned schema and compatibility tests.
2. Risk: concurrent edits cause inconsistent state.
   1. Mitigation: explicit conflict policy and action serialization where needed.
3. Risk: terminal stream volume overwhelms mobile UI.
   1. Mitigation: chunking, backpressure, and virtualized rendering.
4. Risk: security regressions in pairing/auth.
   1. Mitigation: threat model, pen-test checklist, revocation tests.

## Suggested Timeline (conservative)

1. Phase 0: Weeks 1-2
2. Phase 1: Weeks 3-5
3. Phase 2: Weeks 6-7
4. Phase 3: Weeks 8-12
5. Phase 4: Weeks 13-15
6. Phase 5: Weeks 16-19

## Milestone Gates

1. Gate A: Protocol freeze (end Phase 0).
2. Gate B: Desktop sync core stable (end Phase 1).
3. Gate C: Secure pairing complete (end Phase 2).
4. Gate D: Mobile MVP feature complete (end Phase 3).
5. Gate E: Beta reliability targets met (end Phase 5).

## Immediate Next Steps

1. Create `protocol-v1.md` with concrete payload examples.
2. Implement desktop sync service skeleton and event bus adapter.
3. Add golden-file tests for snapshot and event replay.
4. Build mobile connect screen and snapshot renderer first.
