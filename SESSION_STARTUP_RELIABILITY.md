# Session Startup Reliability Write-Up

Date: February 7, 2026

## Goal

Make session startup latency measurable and debuggable without relying on manual UI reporting.

## What Was Added

1. Real startup probe script:
   - `/Users/paulrohde/CodeProjects/external/opcode/scripts/measure-session-startup.mjs`
2. NPM commands:
   - `npm run debug:session-start`
   - `npm run debug:session-start:json`
   - `npm run debug:session-start:gate`
3. Smoke regression timing assertion:
   - `/Users/paulrohde/CodeProjects/external/opcode/tests/smoke/workspace-persistence.spec.ts`
   - Ensures slow-start warning path appears quickly and spinner does not hang.

## Measured Results (Real Provider Runs, No Mocked Stream)

Command shape used:

```bash
npm run debug:session-start -- \
  --project /Users/paulrohde/CodeProjects/external/opcode \
  --runs 2 \
  --timeout-ms 90000 \
  --json
```

Observed:

1. First response byte latency:
   - Run 1: `30624ms`
   - Run 2: `30630ms`
   - Aggregate: `p50=30624ms`, `p95=30630ms`, `avg=30627ms`
2. End-to-end completion:
   - Run 1: `42033ms`
   - Run 2: `41366ms`
   - Aggregate: `p50=41366ms`, `p95=42033ms`
3. `--include-partial-messages` did not materially reduce first-byte latency (still ~30.6s).
4. Model `haiku` produced similar startup latency (~30.7s first-byte in one run).

## Interpretation

1. The UI watchdog warning threshold is not the root bottleneck.
2. The dominant delay is provider-side startup/first-token latency in this environment.
3. Existing warning/error UX is still useful because it prevents silent hanging, but it cannot make provider startup itself fast.

## Standard Debugging Workflow

Use this every time latency is reported:

1. In app:
   - Open utility rail -> Diagnostics.
   - Use `Run Startup Probe` for first-output timing.
   - Use `Run Assistant Benchmark` for first assistant-message timing.
   - Results are shown in `Latest Probe` and logged into diagnostics timeline.

2. CLI baseline probe:

```bash
npm run debug:session-start -- \
  --project /absolute/project/path \
  --runs 3 \
  --timeout-ms 90000 \
  --json
```

3. Compare first-byte latency (`aggregates.firstByte.p50Ms` and `p95Ms`) against your target.
4. Run gate check if needed:

```bash
npm run debug:session-start:gate
```

5. If gate fails, treat as real startup regression unless runtime/provider changes explain it.

## CI/Automation Recommendation

1. Keep mocked Playwright smoke tests for deterministic UI behavior.
2. Use `.github/workflows/session-latency-benchmark.yml` for scheduled + manual probe runs.
3. Configure repository secret: `ANTHROPIC_API_KEY`.
4. The workflow runs both:
   - startup first-byte gate,
   - assistant first-message gate.
5. JSON outputs are uploaded as workflow artifacts (`startup-probe.json`, `assistant-probe.json`).

## Notes

1. The probe uses the same print-mode CLI path used by the app execution flow (`claude -p ... --output-format stream-json`).
2. If the supplied project path does not exist, preflight should fail immediately in-app (that path is already tested by smoke).
