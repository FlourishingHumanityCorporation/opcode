# Opcode Mobile Companion Roadmap (Updated)

## Date

Updated on **February 9, 2026**.

## Goal

Ship an iOS mobile companion that mirrors live desktop Opcode state and supports core remote control safely over private networking (Tailscale).

## Current Status Snapshot

### Completed

1. Desktop mobile sync service exists in Tauri and runs on port `8091` when enabled.
2. Sync protocol package exists at `/Users/paulrohde/CodeProjects/external/opcode/packages/mobile-sync-protocol`.
3. Core sync endpoints exist:
   1. `GET /mobile/v1/health`
   2. `GET /mobile/v1/snapshot`
   3. `GET /mobile/v1/ws`
   4. `POST /mobile/v1/action`
   5. `POST /mobile/v1/pair/start`
   6. `POST /mobile/v1/pair/claim`
   7. `POST /mobile/v1/device/revoke`
4. Pairing + device registry tables exist (`mobile_devices`, `mobile_pairing_codes`, `mobile_sync_settings`).
5. Desktop settings UI includes mobile sync enable/host/pair/revoke controls.
6. Frontend bridge publishes snapshots/events and consumes `mobile-action-requested`.
7. iOS app scaffold exists in `/Users/paulrohde/CodeProjects/external/opcode/apps/mobile`.
8. Mobile app now supports:
   1. Pair claim (`pairCode + deviceName + host`)
   2. Secure credential persistence via `expo-secure-store`
   3. Auto reconnect + backoff
   4. Snapshot refetch on `sync.resnapshot_required`
   5. Core actions (workspace/tab activate, terminal input, execute/resume/cancel)
9. WebSocket auth now supports query token fallback (`?token=...`) for Expo/browser clients while keeping header auth.
10. Baseline checks pass (`npm run check`, Rust integration test, protocol test).

### In Progress / Partial

1. Mobile views are functional but still MVP-level (not full desktop UX parity).
2. Diagnostics are basic and not yet tied to telemetry dashboards.
3. Action roundtrip works at protocol level, but rich success/failure UX on mobile is minimal.

### Not Done Yet

1. Full state fidelity for terminal/session output rendering on mobile.
2. Conflict policy hardening for simultaneous desktop + mobile edits.
3. Comprehensive automated coverage for mobile sync flows (especially WS query-token auth and auth failure paths).
4. TestFlight build/signing/release pipeline.
5. Beta monitoring and SLO-based rollout gates.

## What We Need Next (Priority Order)

## P0: Stability + Security Hardening (must complete first)

1. Add backend tests for WS auth matrix:
   1. Header bearer token valid
   2. Query token valid
   3. Missing token -> `401`
   4. Invalid/revoked token -> `401`
2. Add mobile integration tests for:
   1. Pair claim success/failure
   2. Persisted reconnect
   3. Auth failure auto-reset to pairing
3. Add explicit error payload handling and surfaced user states in mobile UI.
4. Ensure revoked token behavior is immediate on next snapshot/action/WS reconnect and UI returns to pair flow cleanly.

### Exit criteria

1. No silent auth failures.
2. Revocation behavior deterministic in test.
3. Reconnect loops capped and observable.

## P1: Mirror Fidelity (desktop state parity)

1. Expand mirrored data model for mobile-visible state:
   1. Active workspace/tab metadata
   2. Terminal pane focus and stream summaries
   3. Provider session status/output summaries
2. Publish richer incremental events from desktop bridge (not only coarse workspace change markers).
3. Implement idempotent reducer updates on mobile for event replay.

### Exit criteria

1. Mobile screen state matches desktop active context after connect and during tab/session switches.
2. Snapshot + event replay converges without manual refresh.

## P2: Control UX Completion

1. Add clear command/result feedback for every mobile action.
2. Add guardrails for invalid actions (no active terminal/session, missing IDs, stale context).
3. Add “active target” indicators so users know exactly where prompts/input go.
4. Add action queue UX when temporarily disconnected.

### Exit criteria

1. User can reliably run: switch tab, send terminal input, execute/resume/cancel session.
2. Failures are understandable and recoverable in-app.

## P3: Test + CI/CD Expansion

1. Add dedicated mobile sync backend tests in Rust (auth, sequencing, resync).
2. Add mobile client unit tests for:
   1. Store reducer
   2. reconnect backoff
   3. resnapshot logic
3. Add CI workflow for mobile app typecheck/tests.
4. Add artifact capture for sync failures (logs + traces).

### Exit criteria

1. PRs touching sync/mobile paths run deterministic coverage.
2. Nightly runs catch regression in pairing/sync/control loop.

## P4: TestFlight + Internal Beta

1. Finalize iOS app metadata, signing, and bundle config.
2. Set up internal TestFlight distribution and release checklist.
3. Add beta telemetry dashboard:
   1. connect success rate
   2. median sync lag
   3. action failure rate
   4. auth error rate
4. Define go/no-go thresholds for expanding tester cohort.

### Exit criteria

1. Internal cohort can pair/connect/control for at least one week with no critical blocker.
2. Reliability metrics meet defined thresholds.

## Proposed Timeline From Today

1. Week 1: P0 stability/security hardening.
2. Week 2: P1 mirror fidelity.
3. Week 3: P2 control UX completion.
4. Week 4: P3 CI/test expansion.
5. Week 5: P4 TestFlight setup and internal dogfood.

## Acceptance Gates

1. Gate A: Auth + reconnect reliability proven by automated tests.
2. Gate B: Mobile mirror fidelity validated against live desktop scenarios.
3. Gate C: Core action loop proven stable in daily use.
4. Gate D: TestFlight internal release with monitoring in place.

## Risks and Mitigations

1. Risk: Event schema drift between desktop and mobile.
   1. Mitigation: protocol fixtures + parity tests in Rust and TypeScript.
2. Risk: Reconnect storms or stale sequence loops.
   1. Mitigation: capped exponential backoff + forced resnapshot rules.
3. Risk: Mobile UX mismatch with high-volume terminal/session output.
   1. Mitigation: summarize output for MVP, virtualize rendering in next iteration.
4. Risk: Security regressions in query-token WS auth.
   1. Mitigation: strict auth precedence and regression tests for token validation paths.

## Immediate Execution Checklist

1. Add WS auth regression tests (header/query/missing/revoked).
2. Add mobile auth-failure + reconnect integration tests.
3. Improve mirrored session/terminal output data shape.
4. Add action result/error UI polish.
5. Wire CI workflows for mobile sync + app tests.
6. Prepare TestFlight build settings and internal release runbook.
