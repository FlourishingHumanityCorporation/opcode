# Opcode Mobile Companion Roadmap (Current)

Updated on **February 9, 2026**.

## Goal

Ship an iOS mobile companion that reliably mirrors live desktop Opcode state and supports safe remote control over private networking (Tailscale).

## Status Summary

- `P0` Stability/Security: **Complete**
- `P1` Mirror Fidelity: **Complete**
- `P2` Control UX Completion: **Next**
- `P3` CI/Test Expansion + Observability: **Next**
- `P4` TestFlight/Internal Beta: **Pending**

## Completed in Current Iteration (P0 + P1)

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

## Remaining Work by Phase

## P2: Control UX Completion (1 week target)

### Scope

1. Add per-action status UX (`pending`, `succeeded`, `failed`) for all control actions.
2. Add guardrails and validation for invalid targets (missing terminal/session/workspace context).
3. Add disconnect-safe action handling:
   - reject instantly with user-visible reason, or
   - queue only explicitly retry-safe actions
4. Improve active target labeling on action UI and confirmation toasts.

### Acceptance criteria

1. User can reliably switch workspace/tab, send terminal input, execute/resume/cancel session.
2. No silent action drops.
3. Action failure reason is always visible in UI.

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
3. Gate C (next): P2 action UX reliability and error clarity.
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

1. Implement action result/error UX and retry-safe disconnect handling (`P2`).
2. Add reducer convergence and action failure-path tests (`P3`).
3. Add minimal connect/action/auth telemetry events (`P3`).
4. Define internal TestFlight release checklist draft (`P4` prep).
