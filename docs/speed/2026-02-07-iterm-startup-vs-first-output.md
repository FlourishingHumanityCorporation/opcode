# Speed Exploration: Claude Startup vs First Model Output (iTerm)

Date: 2026-02-07
Repo: `/Users/paulrohde/CodeProjects/external/codeinterfacex`

## Goal
Determine whether observed latency comes from:
1. Starting `claude` itself, or
2. Getting first model output after sending a prompt.

## Final Findings
1. `claude` process startup is fast.
2. Most latency is in model request/response, not CLI launch.

## Benchmarks Run

### A) Shell benchmark (`-p` prompt path, non-iTerm)
Command:

```bash
npm run debug:session-start:json -- --runs 3
npm run debug:assistant-benchmark:json -- --runs 3
```

Observed aggregates:

1. Startup benchmark:
   - first byte avg: `30935.33 ms`
   - first assistant avg: `41667.33 ms`
2. Assistant benchmark:
   - first byte avg: `30680.67 ms`
   - first assistant avg: `40593.00 ms`

This confirms slow first output, but these are not iTerm-specific.

### B) iTerm benchmark (`-p` prompt path, true iTerm)
Method:
1. Open fresh iTerm tab.
2. Run `claude -p ... --output-format stream-json`.
3. Measure:
   - first stdout byte
   - first `"type":"assistant"` event
   - completion

Runs (ms):

| Run | first_byte_ms | first_assistant_ms | total_ms |
| --- | ---: | ---: | ---: |
| 1 | 32525 | 44346 | 44970 |
| 2 | 32833 | 43752 | 44251 |
| 3 | 32533 | 42108 | 42735 |

Aggregate:
1. first byte avg: `32630.33 ms`
2. first assistant avg: `43402.00 ms`
3. total avg: `43985.33 ms`

### C) iTerm startup-only benchmark (`claude` interactive, no prompt)
Method:
1. Open fresh iTerm tab.
2. Run `claude --debug-file <tmp_log>`.
3. Parse Claude debug log line:
   - `[render] first ink render: <N>ms since process start`

Runs:

| Run | first_ink_render_ms | wall_until_render_seen_ms |
| --- | ---: | ---: |
| 1 | 267 | 2155 |
| 2 | 291 | 1894 |
| 3 | 269 | 1951 |
| 4 | 240 | 1756 |
| 5 | 261 | 1843 |

Aggregate:
1. first ink render avg: `265.60 ms`
2. wall until render seen avg: `1919.80 ms`

### D) CLI cold sanity check (`--version`)
Command:

```bash
/Users/paulrohde/.local/bin/claude --version
```

5-run timing:
1. avg: `48.8 ms`
2. min/max: `48/49 ms`

## Interpretation
1. Startup of `claude` itself is not the bottleneck.
2. The dominant delay is between request start and first assistant token when using `-p`.
3. In this environment on 2026-02-07, first assistant output in iTerm is about `42-44s`.

## Notes
1. An early mixed-method run undercounted iTerm specificity; the final numbers above use explicit iTerm-tab execution.
2. iTerm startup benchmark and `-p` benchmark measure different things:
   - startup benchmark: UI readiness
   - `-p` benchmark: model output latency
