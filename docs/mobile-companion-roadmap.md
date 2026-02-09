# Opcode Mobile Companion Roadmap (Current)

Updated on **February 9, 2026**.

## Goal

Ship an iOS mobile companion that reliably mirrors live desktop Opcode state and supports safe remote control over private networking (Tailscale).

## Status Summary

- `P0` Stability/Security: **Complete**
- `P1` Mirror Fidelity: **Complete**
- `P2` Control UX Completion: **Complete**
- `P3` CI/Test Expansion + Observability: **Next**
- `P4` TestFlight/Internal Beta: **Pending**

## Completed in Current Iteration (P0 + P1 + P2)

1. WebSocket auth hardening on desktop sync service:
   - header token preferred, query token fallback supported
   - missing/invalid/revoked token returns unauthorized
2. Backend auth regression tests added for token selection and unauthorized mapping.
3. Mobile auth/reconnect hardening:
   - bounded exponential backoff with jitter
   - auth failure reset clears persisted creds and routes back to pairing
   - stale/out-of-order event rejection
   - `sync.resnapshot_required` refresh behavior
4. Desktop-to-mobile mirror payload enrichment:
   - `workspace.state_changed` includes active context IDs and counts
   - additive summary events: `terminal.state_summary`, `provider_session.state_summary`
5. Mobile store/reducer upgrades to consume enriched events and patch active context quickly.
6. Mobile diagnostics upgrades:
   - connection status, sequence, event/snapshot age, reconnect count, active target IDs
7. Mobile tests added:
   - protocol client tests
   - reconnect/auth-reset tests
   - store reducer tests for sequence/resnapshot/summary events
8. Desktop bridge tests added for enriched payload builders.
9. CI workflows updated so mobile install, typecheck, and tests run from `apps/mobile` context.
10. Centralized mobile action execution flow:
   - single-flight action model
   - consistent guard evaluation before execution
   - structured action lifecycle logs (`start`, `success`, `failed`)
11. Action UX completion across workspace/terminal/session controls:
   - explicit action status (`pending`, `succeeded`, `failed`)
   - deterministic blocked reasons (`Disconnected`, invalid target, action in progress, empty input)
   - no queued replay while disconnected (immediate reject policy)
12. Active target clarity and diagnostics:
   - action target labels shown at control points
   - diagnostics panel includes recent action history and policy note
13. Added P2-focused mobile tests:
   - action execution/guard/history unit tests
   - screen guard reason helper tests
   - reconnect test coverage extended for action-state transitions

## Remaining Work by Phase

## P3: Test + CI Expansion + Baseline Observability (1 week target)

### Scope

1. Expand Rust sync coverage:
   - sequence gap/resnapshot behavior
   - action routing failure paths
   - revocation enforcement on reconnect
2. Expand mobile tests:
   - reducer convergence after mixed snapshot + event replay
   - reconnect edge cases and auth invalidation
3. CI tightening:
   - enforce mobile checks on all sync-impacting PR paths
   - keep nightly artifacts for mobile and sync failures
4. Add minimal runtime metrics/logging:
   - connect success/fail
   - reconnect attempts
   - action latency/failure
   - auth failures/revocations

### Acceptance criteria

1. PR checks are deterministic and include mobile typecheck + tests + sync backend tests.
2. Nightly catches regression in pairing/sync/control paths with actionable artifacts.
3. Baseline telemetry exists for internal beta decisions.

## P4: TestFlight + Internal Beta (1-2 week target)

### Scope

1. Finalize iOS metadata/signing/release profile.
2. Build internal TestFlight distribution checklist and release playbook.
3. Define go/no-go thresholds:
   - connect success rate
   - median event lag
   - action failure rate
   - auth error rate
4. Run 1 week of internal dogfooding and collect issues.

### Acceptance criteria

1. Internal cohort can pair, reconnect, mirror, and execute core actions without blockers.
2. Metrics remain within agreed thresholds before expanding testers.

## Execution Order and Gates

1. Gate A (already passed): P0 auth/reconnect reliability.
2. Gate B (already passed): P1 mirror active-context fidelity.
3. Gate C (already passed): P2 action UX reliability and error clarity.
4. Gate D (next): P3 deterministic CI + baseline telemetry.
5. Gate E (final): P4 TestFlight internal beta readiness.

## Risks and Mitigations

1. Risk: terminal/session output volume overwhelms mobile rendering.
   - Mitigation: keep summarized view as default, add virtualization incrementally.
2. Risk: drift between snapshot and incremental event semantics.
   - Mitigation: convergence tests (snapshot replay after event stream).
3. Risk: query-token auth path regression for Expo/browser clients.
   - Mitigation: preserve explicit auth matrix tests in CI.
4. Risk: flaky reconnect behavior on mobile network transitions.
   - Mitigation: keep capped backoff + auth-reset behavior + diagnostics visibility.

## Immediate Checklist (What We Need Now)

1. Add remaining reducer convergence and action failure-path tests (`P3`).
2. Tighten PR/nightly CI gates for sync + mobile regressions (`P3`).
3. Add baseline connect/action/auth telemetry events (`P3`).
4. Draft internal TestFlight release checklist and go/no-go thresholds (`P4` prep).
