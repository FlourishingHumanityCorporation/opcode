#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { cwd as processCwd, env, exit } from "node:process";

function parseArgs(argv) {
  const config = {
    projectPath: processCwd(),
    prompt: "Reply with exactly OK and nothing else.",
    model: "sonnet",
    runs: 1,
    timeoutMs: 120_000,
    providerBinary: env.OPCODE_PROVIDER_BIN || "claude",
    includePartialMessages: false,
    failOnSlowMs: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--project" && next) {
      config.projectPath = next;
      i += 1;
      continue;
    }
    if (arg === "--prompt" && next) {
      config.prompt = next;
      i += 1;
      continue;
    }
    if (arg === "--model" && next) {
      config.model = next;
      i += 1;
      continue;
    }
    if (arg === "--runs" && next) {
      config.runs = Math.max(1, Number.parseInt(next, 10) || 1);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      config.timeoutMs = Math.max(1_000, Number.parseInt(next, 10) || 120_000);
      i += 1;
      continue;
    }
    if (arg === "--provider-bin" && next) {
      config.providerBinary = next;
      i += 1;
      continue;
    }
    if (arg === "--include-partial-messages") {
      config.includePartialMessages = true;
      continue;
    }
    if (arg === "--fail-on-slow-ms" && next) {
      config.failOnSlowMs = Math.max(1, Number.parseInt(next, 10) || 1);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      config.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log("Measure startup latency for Claude-style print sessions.");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/measure-session-startup.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --project <path>                 Working directory for provider process");
  console.log("  --prompt <text>                  Prompt to run");
  console.log("  --model <id>                     Model id (default: sonnet)");
  console.log("  --runs <n>                       Number of runs (default: 1)");
  console.log("  --timeout-ms <ms>                Per-run timeout (default: 120000)");
  console.log("  --provider-bin <path|command>    Provider CLI binary (default: claude)");
  console.log("  --include-partial-messages       Add --include-partial-messages flag");
  console.log("  --fail-on-slow-ms <ms>           Exit non-zero if p95 first-byte exceeds ms");
  console.log("  --json                           Emit JSON summary");
  console.log("  --help                           Show this help");
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * fraction) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx];
}

function stats(values) {
  if (values.length === 0) {
    return { samples: 0, minMs: null, maxMs: null, p50Ms: null, p95Ms: null, avgMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((acc, value) => acc + value, 0);
  return {
    samples: values.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    avgMs: Math.round((total / values.length) * 100) / 100,
  };
}

function resolveBinary(binary) {
  if (binary.includes("/")) {
    return binary;
  }

  const resolved = spawnSync("which", [binary], {
    env,
    encoding: "utf-8",
  });

  if (resolved.status === 0) {
    const output = (resolved.stdout || "").trim();
    if (output.length > 0) {
      return output;
    }
  }

  return binary;
}

function runOnce(config, runNumber) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = [
      "-p",
      config.prompt,
      "--model",
      config.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (config.includePartialMessages) {
      args.push("--include-partial-messages");
    }

    const child = spawn(config.providerBinary, args, {
      cwd: config.projectPath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let firstStdoutMs = null;
    let firstStderrMs = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const mark = (which, buffer) => {
      if (which === "stdout" && firstStdoutMs === null && buffer.length > 0) {
        firstStdoutMs = Date.now() - startedAt;
      }
      if (which === "stderr" && firstStderrMs === null && buffer.length > 0) {
        firstStderrMs = Date.now() - startedAt;
      }
      if (which === "stdout") stdoutBytes += buffer.length;
      if (which === "stderr") stderrBytes += buffer.length;
    };

    child.stdout.on("data", (chunk) => mark("stdout", chunk));
    child.stderr.on("data", (chunk) => mark("stderr", chunk));

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      const totalMs = Date.now() - startedAt;
      const firstByteMs = [firstStdoutMs, firstStderrMs].filter((value) => value !== null);
      resolve({
        run: runNumber,
        exitCode: code,
        signal,
        timedOut,
        totalMs,
        firstStdoutMs,
        firstStderrMs,
        firstByteMs: firstByteMs.length > 0 ? Math.min(...firstByteMs) : null,
        stdoutBytes,
        stderrBytes,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      resolve({
        run: runNumber,
        exitCode: null,
        signal: null,
        timedOut: false,
        totalMs: Date.now() - startedAt,
        firstStdoutMs: null,
        firstStderrMs: null,
        firstByteMs: null,
        stdoutBytes,
        stderrBytes,
        error: error.message,
      });
    });
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  config.providerBinary = resolveBinary(config.providerBinary);
  const runs = [];

  for (let i = 1; i <= config.runs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runOnce(config, i);
    runs.push(result);
  }

  const firstByteValues = runs
    .map((run) => run.firstByteMs)
    .filter((value) => typeof value === "number");
  const totalValues = runs.map((run) => run.totalMs).filter((value) => typeof value === "number");
  const timeoutCount = runs.filter((run) => run.timedOut).length;
  const successCount = runs.filter((run) => run.exitCode === 0 && !run.timedOut).length;

  const summary = {
    config: {
      projectPath: config.projectPath,
      model: config.model,
      runs: config.runs,
      timeoutMs: config.timeoutMs,
      providerBinary: config.providerBinary,
      includePartialMessages: config.includePartialMessages,
    },
    results: runs,
    aggregates: {
      successCount,
      timeoutCount,
      firstByte: stats(firstByteValues),
      totalDuration: stats(totalValues),
    },
  };

  if (config.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("Session Startup Probe");
    console.log(
      `binary=${config.providerBinary} model=${config.model} runs=${config.runs} timeoutMs=${config.timeoutMs}`
    );
    console.log(`project=${config.projectPath}`);
    runs.forEach((run) => {
      console.log(
        `run=${run.run} firstByteMs=${run.firstByteMs ?? "n/a"} totalMs=${run.totalMs} exit=${run.exitCode ?? "null"} signal=${run.signal ?? "none"} timeout=${run.timedOut}`
      );
    });
    console.log(
      `summary: success=${successCount}/${config.runs} timeouts=${timeoutCount} firstByteP50=${summary.aggregates.firstByte.p50Ms ?? "n/a"}ms firstByteP95=${summary.aggregates.firstByte.p95Ms ?? "n/a"}ms`
    );
  }

  if (config.failOnSlowMs !== null) {
    const p95 = summary.aggregates.firstByte.p95Ms;
    if (timeoutCount > 0 || p95 === null || p95 > config.failOnSlowMs) {
      console.error(
        `FAIL: first-byte latency gate failed (p95=${p95 ?? "n/a"}ms, timeoutCount=${timeoutCount}, max=${config.failOnSlowMs}ms)`
      );
      exit(2);
    }
  }
}

main().catch((error) => {
  console.error("Probe failed:", error);
  exit(1);
});
