#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const WINDOW_WIDTH_KEY = "window_width";
const WINDOW_HEIGHT_KEY = "window_height";
const APP_NAME = "codeinterfacex";
const PROCESS_NAME = "codeinterfacex";

const defaultBinaryPath = path.resolve(repoRoot, "src-tauri/target/debug/codeinterfacex");
const defaultDbPath = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "com.flourishinghumanity.codeinterfacex",
  "agents.db"
);

const binaryPath = process.env.CODEINTERFACEX_WINDOW_TEST_BINARY || defaultBinaryPath;
const dbPath = process.env.CODEINTERFACEX_WINDOW_TEST_DB_PATH || defaultDbPath;
const skipBuild = process.env.CODEINTERFACEX_WINDOW_TEST_SKIP_BUILD === "1";
const tolerancePx = Number.parseInt(process.env.CODEINTERFACEX_WINDOW_TEST_TOLERANCE_PX || "20", 10);

const scenarioOneTarget = { width: 980, height: 700 };
const scenarioTwoTarget = { width: 1120, height: 760 };

let originalWidthSnapshot = { exists: false, quotedValue: null };
let originalHeightSnapshot = { exists: false, quotedValue: null };

function logStep(message) {
  console.log(`[STEP] ${message}`);
}

function logPass(message) {
  console.log(`[PASS] ${message}`);
}

function logInfo(message) {
  console.log(`[INFO] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf-8",
    stdio: options.stdio ?? "pipe",
  });

  if (result.error) {
    fail(`Failed to run command ${cmd}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    const details = stderr.length > 0 ? stderr : stdout;
    fail(`${cmd} ${args.join(" ")} failed with exit code ${result.status}: ${details}`);
  }

  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function checkToolExists(name) {
  const result = spawnSync("which", [name], { encoding: "utf-8" });
  if (result.status !== 0) {
    fail(`Required tool not found in PATH: ${name}`);
  }
}

function processPids() {
  const result = spawnSync("pgrep", ["-x", PROCESS_NAME], { encoding: "utf-8" });
  if (result.status !== 0) {
    return [];
  }

  return (result.stdout || "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isProcessRunning() {
  return processPids().length > 0;
}

function sqlQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function runSql(sql, options = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const result = spawnSync("sqlite3", [dbPath, sql], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  if (result.error) {
    fail(`Failed to run sqlite3: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (options.allowMissingTable && /no such table/i.test(stderr)) {
      return "";
    }
    fail(`sqlite3 failed: ${stderr}`);
  }

  return (result.stdout || "").trim();
}

function readSettingSnapshot(key) {
  const existsRaw = runSql(
    `SELECT COUNT(1) FROM app_settings WHERE key = ${sqlQuote(key)};`,
    { allowMissingTable: true }
  );
  const exists = Number.parseInt(existsRaw || "0", 10) > 0;
  if (!exists) {
    return { exists: false, quotedValue: null };
  }

  const quotedValue = runSql(
    `SELECT quote(value) FROM app_settings WHERE key = ${sqlQuote(key)} LIMIT 1;`,
    { allowMissingTable: true }
  );
  return { exists: true, quotedValue: quotedValue || "''" };
}

function restoreSetting(key, snapshot) {
  if (!snapshot.exists) {
    runSql(`DELETE FROM app_settings WHERE key = ${sqlQuote(key)};`, {
      allowMissingTable: true,
    });
    return;
  }

  const quotedValue = snapshot.quotedValue ?? "''";
  runSql(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES (${sqlQuote(key)}, ${quotedValue});`,
    { allowMissingTable: true }
  );
}

function readWindowSettingsFromDb() {
  const rows = runSql(
    `SELECT key, value FROM app_settings WHERE key IN (${sqlQuote(WINDOW_WIDTH_KEY)}, ${sqlQuote(WINDOW_HEIGHT_KEY)}) ORDER BY key;`,
    { allowMissingTable: true }
  );

  const map = new Map();
  for (const line of rows.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [key, value] = trimmed.split("|");
    if (key && value !== undefined) {
      map.set(key, value);
    }
  }

  const widthRaw = map.get(WINDOW_WIDTH_KEY);
  const heightRaw = map.get(WINDOW_HEIGHT_KEY);
  if (!widthRaw || !heightRaw) {
    fail(
      `Expected DB keys ${WINDOW_WIDTH_KEY} and ${WINDOW_HEIGHT_KEY} to exist, got width=${String(widthRaw)} height=${String(heightRaw)}`
    );
  }

  const width = Number.parseFloat(widthRaw);
  const height = Number.parseFloat(heightRaw);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    fail(`DB keys are not valid numeric values: width=${widthRaw} height=${heightRaw}`);
  }

  return { width, height };
}

function toAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script, options = {}) {
  const result = spawnSync("osascript", ["-e", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: options.timeoutMs ?? 15_000,
    killSignal: "SIGKILL",
  });

  if (result.error) {
    if (result.error.name === "Error" && String(result.error.message || "").includes("ETIMEDOUT")) {
      if (options.allowFailure) return null;
      fail("osascript timed out");
    }
    if (options.allowFailure) return null;
    fail(`Failed to run osascript: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (options.allowFailure) return null;
    fail(`osascript failed: ${stderr}`);
  }

  return (result.stdout || "").trim();
}

function parseSize(value) {
  const parts = value.split(",").map((entry) => Number.parseFloat(entry.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    fail(`Unable to parse window size from AppleScript output: "${value}"`);
  }
  return { width: parts[0], height: parts[1] };
}

function launchAppBinary() {
  const child = spawn(binaryPath, [], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

function tryReadWindowSize() {
  const output = runAppleScript(
    `
tell application "System Events"
  if not (exists process "${toAppleScriptString(PROCESS_NAME)}") then error "process_missing"
  tell process "${toAppleScriptString(PROCESS_NAME)}"
    if (count of windows) = 0 then error "window_missing"
    set targetWindow to missing value
    set bestArea to -1
    repeat with w in windows
      try
        set s to size of w
        set area to (item 1 of s) * (item 2 of s)
        if area > bestArea then
          set bestArea to area
          set targetWindow to w
        end if
      end try
    end repeat
    if targetWindow is missing value then error "window_missing"
    set s to size of targetWindow
    return (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell
`,
    { allowFailure: true }
  );

  if (!output) return null;
  return parseSize(output);
}

async function waitForWindow(timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "window not available";

  while (Date.now() < deadline) {
    try {
      const size = tryReadWindowSize();
      if (size) return size;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }

  fail(`Timed out waiting for window (${label}): ${lastError}`);
}

async function waitForNoWindow(timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const size = tryReadWindowSize();
    if (!size) return;
    await sleep(250);
  }

  fail(`Timed out waiting for window to close (${label})`);
}

function activateApp() {
  return runAppleScript(
    `
try
  tell application "${toAppleScriptString(APP_NAME)}" to activate
  return "application_activate"
on error
  tell application "System Events"
    if not (exists process "${toAppleScriptString(PROCESS_NAME)}") then error "process_missing"
    tell process "${toAppleScriptString(PROCESS_NAME)}"
      set frontmost to true
      return "process_frontmost"
    end tell
  end tell
end try
`
  );
}

function setWindowSize(width, height) {
  const output = runAppleScript(
    `
tell application "System Events"
  tell process "${toAppleScriptString(PROCESS_NAME)}"
    if (count of windows) = 0 then error "window_missing"
    set frontmost to true
    set targetWindow to missing value
    set bestArea to -1
    repeat with w in windows
      try
        set s to size of w
        set area to (item 1 of s) * (item 2 of s)
        if area > bestArea then
          set bestArea to area
          set targetWindow to w
        end if
      end try
    end repeat
    if targetWindow is missing value then error "window_missing"
    set size of targetWindow to {${Math.round(width)}, ${Math.round(height)}}
    delay 0.15
    set s to size of targetWindow
    return (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell
`
  );
  return parseSize(output);
}

function clickRedCloseButtonOrFallback() {
  return runAppleScript(
    `
tell application "System Events"
  tell process "${toAppleScriptString(PROCESS_NAME)}"
    if (count of windows) = 0 then error "window_missing"
    set frontmost to true
    set targetWindow to missing value
    set bestArea to -1
    repeat with w in windows
      try
        set s to size of w
        set area to (item 1 of s) * (item 2 of s)
        if area > bestArea then
          set bestArea to area
          set targetWindow to w
        end if
      end try
    end repeat
    if targetWindow is missing value then error "window_missing"

    try
      click button 1 of targetWindow
      return "clicked_button_1"
    end try

    try
      set uiItems to entire contents of targetWindow
      repeat with uiItem in uiItems
        try
          if (role of uiItem as text) is "AXButton" then
            set itemName to ""
            set itemDescription to ""
            set itemTitle to ""
            try
              set itemName to name of uiItem as text
            end try
            try
              set itemDescription to description of uiItem as text
            end try
            try
              set itemTitle to title of uiItem as text
            end try

            if itemName contains "Close" or itemDescription contains "Close" or itemTitle contains "Close" then
              click uiItem
              return "clicked_named_close_button"
            end if
          end if
        end try
      end repeat
    end try

    try
      set windowPos to position of targetWindow
      set clickX to (item 1 of windowPos) + 14
      set clickY to (item 2 of windowPos) + 14
      click at {clickX, clickY}
      return "fallback_click_top_left"
    end try
  end tell
  keystroke "w" using command down
  return "fallback_command_w"
end tell
`
  );
}

function quitViaAppleScript() {
  return runAppleScript(
    `
try
  tell application "${toAppleScriptString(APP_NAME)}" to quit
  return "application_quit"
on error
  tell application "System Events"
    if not (exists process "${toAppleScriptString(PROCESS_NAME)}") then error "process_missing"
    tell process "${toAppleScriptString(PROCESS_NAME)}" to quit
    return "process_quit"
  end tell
end try
`,
    { allowFailure: false }
  );
}

async function waitForProcessExit(timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning()) return;
    await sleep(250);
  }
  fail(`Timed out waiting for ${PROCESS_NAME} process to exit (${label})`);
}

async function ensureProcessExit(timeoutMs, label) {
  try {
    await waitForProcessExit(timeoutMs, label);
    return;
  } catch (error) {
    logInfo(
      `Graceful exit timed out for ${label}; forcing process termination (${error instanceof Error ? error.message : String(error)})`
    );
  }

  spawnSync("pkill", ["-x", PROCESS_NAME], { encoding: "utf-8" });
  await waitForProcessExit(8_000, `${label} forced`);
}

async function resetAppProcess(label) {
  if (!isProcessRunning()) return;
  logInfo(`Resetting app process (${label})`);
  runAppleScript(`tell application "${toAppleScriptString(APP_NAME)}" to quit`, {
    allowFailure: true,
  });
  await sleep(700);
  if (isProcessRunning()) {
    spawnSync("pkill", ["-x", PROCESS_NAME], { encoding: "utf-8" });
    await sleep(700);
  }
  await waitForProcessExit(8_000, `${label} reset`);
}

function assertClose(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  if (delta > tolerance) {
    fail(
      `${label} out of tolerance: expected=${expected}, actual=${actual}, delta=${delta}, tolerance=${tolerance}`
    );
  }
}

function assertSizeWithinTolerance(actual, expected, tolerance, label) {
  assertClose(actual.width, expected.width, tolerance, `${label} width`);
  assertClose(actual.height, expected.height, tolerance, `${label} height`);
}

async function reopenViaActivateOrLaunch() {
  try {
    activateApp();
    await waitForWindow(12_000, "activate existing process");
    return "activate";
  } catch (error) {
    logInfo(
      `Activate path did not restore a window; falling back to relaunch (${error instanceof Error ? error.message : String(error)})`
    );
    launchAppBinary();
    await waitForWindow(30_000, "relaunch fallback");
    return "relaunch";
  }
}

async function scenarioQuitRelaunch() {
  logStep("Scenario A: quit + relaunch restores last window size");
  await resetAppProcess("scenario A start");
  launchAppBinary();
  await waitForWindow(30_000, "initial launch");
  const activateMethod = activateApp();
  logInfo(`Scenario A activate method: ${activateMethod}`);

  const immediate = setWindowSize(scenarioOneTarget.width, scenarioOneTarget.height);
  assertSizeWithinTolerance(
    immediate,
    scenarioOneTarget,
    tolerancePx,
    "Immediate post-resize window size (scenario A)"
  );
  logPass(
    `Scenario A resized window to ~${scenarioOneTarget.width}x${scenarioOneTarget.height} (actual ${Math.round(immediate.width)}x${Math.round(immediate.height)})`
  );

  const quitMethod = quitViaAppleScript();
  logInfo(`Scenario A quit method: ${quitMethod}`);
  await ensureProcessExit(20_000, "scenario A quit");

  const dbAfterQuit = readWindowSettingsFromDb();
  logPass(
    `Scenario A DB persisted numeric keys after quit: width=${dbAfterQuit.width}, height=${dbAfterQuit.height}`
  );

  launchAppBinary();
  await waitForWindow(30_000, "scenario A relaunch");
  const restored = await waitForWindow(8_000, "scenario A restored size");
  assertSizeWithinTolerance(
    restored,
    scenarioOneTarget,
    tolerancePx,
    "Scenario A restored window size"
  );

  const dbAfterRelaunch = readWindowSettingsFromDb();
  assertSizeWithinTolerance(
    dbAfterRelaunch,
    restored,
    tolerancePx,
    "Scenario A DB values vs restored size"
  );
  logPass(
    `Scenario A restore validated. Restored window=${Math.round(restored.width)}x${Math.round(restored.height)}, DB=${dbAfterRelaunch.width}x${dbAfterRelaunch.height}`
  );
}

async function scenarioRedCloseReopen() {
  logStep("Scenario B: red-close + reopen restores last window size");
  await resetAppProcess("scenario B start");
  launchAppBinary();
  await waitForWindow(30_000, "scenario B initial launch");
  const activateMethod = activateApp();
  logInfo(`Scenario B activate method: ${activateMethod}`);
  try {
    await waitForWindow(8_000, "scenario B precondition window exists");
  } catch (error) {
    logInfo(
      `Scenario B precondition wait failed; retrying fresh launch (${error instanceof Error ? error.message : String(error)})`
    );
    await resetAppProcess("scenario B precondition retry");
    launchAppBinary();
    await waitForWindow(30_000, "scenario B retry launch");
    activateApp();
    await waitForWindow(8_000, "scenario B precondition window exists retry");
  }

  const immediate = setWindowSize(scenarioTwoTarget.width, scenarioTwoTarget.height);
  assertSizeWithinTolerance(
    immediate,
    scenarioTwoTarget,
    tolerancePx,
    "Immediate post-resize window size (scenario B)"
  );
  logPass(
    `Scenario B resized window to ~${scenarioTwoTarget.width}x${scenarioTwoTarget.height} (actual ${Math.round(immediate.width)}x${Math.round(immediate.height)})`
  );

  const closeMethod = clickRedCloseButtonOrFallback();
  await waitForNoWindow(15_000, "scenario B close window");
  logInfo(`Scenario B close action: ${closeMethod}`);

  const dbAfterClose = readWindowSettingsFromDb();
  logPass(
    `Scenario B DB persisted numeric keys after close: width=${dbAfterClose.width}, height=${dbAfterClose.height}`
  );

  const reopenMethod = await reopenViaActivateOrLaunch();
  const restored = await waitForWindow(12_000, "scenario B restored after reopen");
  assertSizeWithinTolerance(
    restored,
    scenarioTwoTarget,
    tolerancePx,
    "Scenario B restored window size"
  );

  const dbAfterReopen = readWindowSettingsFromDb();
  assertSizeWithinTolerance(
    dbAfterReopen,
    restored,
    tolerancePx,
    "Scenario B DB values vs restored size"
  );
  logPass(
    `Scenario B restore validated via ${reopenMethod}. Restored window=${Math.round(restored.width)}x${Math.round(restored.height)}, DB=${dbAfterReopen.width}x${dbAfterReopen.height}`
  );
}

function preflightChecks() {
  logStep("Running preflight checks");
  if (process.platform !== "darwin") {
    fail("This interactive test only runs on macOS.");
  }

  if (!Number.isFinite(tolerancePx) || tolerancePx < 0) {
    fail(`Invalid CODEINTERFACEX_WINDOW_TEST_TOLERANCE_PX: ${String(process.env.CODEINTERFACEX_WINDOW_TEST_TOLERANCE_PX)}`);
  }

  checkToolExists("osascript");
  checkToolExists("sqlite3");
  if (isProcessRunning()) {
    const pids = processPids().join(", ");
    fail(`Detected existing ${PROCESS_NAME} process(es). Close the app first and retry. PIDs: ${pids}`);
  }
  logPass("Preflight checks passed");
}

function maybeBuild() {
  if (skipBuild) {
    logStep("Skipping build (CODEINTERFACEX_WINDOW_TEST_SKIP_BUILD=1)");
  } else {
    logStep("Building frontend and Tauri debug binary");
    runCommand("npm", ["run", "build"], { stdio: "inherit" });
    runCommand("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], {
      stdio: "inherit",
    });
    logPass("Build completed");
  }

  if (!fs.existsSync(binaryPath)) {
    fail(`App binary not found at ${binaryPath}`);
  }
}

function snapshotDbSettings() {
  logStep(`Snapshotting DB settings from ${dbPath}`);
  originalWidthSnapshot = readSettingSnapshot(WINDOW_WIDTH_KEY);
  originalHeightSnapshot = readSettingSnapshot(WINDOW_HEIGHT_KEY);
  logPass("Captured original DB window settings snapshot");
}

async function cleanup() {
  logStep("Cleanup: closing app and restoring DB settings");

  if (isProcessRunning()) {
    runAppleScript(`tell application "${toAppleScriptString(APP_NAME)}" to quit`, {
      allowFailure: true,
    });
    await sleep(700);
  }

  if (isProcessRunning()) {
    spawnSync("pkill", ["-x", PROCESS_NAME], { encoding: "utf-8" });
    await sleep(700);
  }

  restoreSetting(WINDOW_WIDTH_KEY, originalWidthSnapshot);
  restoreSetting(WINDOW_HEIGHT_KEY, originalHeightSnapshot);
  logPass("Cleanup complete");
}

async function main() {
  console.log("=== Interactive Window Size Persistence Test (macOS) ===");
  console.log(`Binary: ${binaryPath}`);
  console.log(`DB: ${dbPath}`);
  console.log(`Tolerance: ${tolerancePx}px`);
  console.log(`Skip build: ${skipBuild ? "yes" : "no"}`);

  let failed = false;
  try {
    preflightChecks();
    maybeBuild();
    snapshotDbSettings();
    const failures = [];

    try {
      await scenarioQuitRelaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`Scenario A failed: ${message}`);
      console.error(`[FAIL] Scenario A failed: ${message}`);
    }

    try {
      await scenarioRedCloseReopen();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`Scenario B failed: ${message}`);
      console.error(`[FAIL] Scenario B failed: ${message}`);
    }

    if (failures.length > 0) {
      failed = true;
      console.error("[FAIL] One or more scenarios failed:");
      for (const failureMessage of failures) {
        console.error(`[FAIL] ${failureMessage}`);
      }
    } else {
      logPass("All scenarios passed");
    }
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] ${message}`);
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`[FAIL] Cleanup failed: ${message}`);
      failed = true;
    }
  }

  process.exit(failed ? 1 : 0);
}

await main();
