import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");

export interface ScriptSandbox {
  rootDir: string;
  homeDir: string;
  binDir: string;
  logFile: string;
  env: Record<string, string>;
}

export function createSandbox(): ScriptSandbox {
  const rootDir = mkdtempSync(path.join(tmpdir(), "codeinterfacex-remote-access-"));
  const homeDir = path.join(rootDir, "home");
  const binDir = path.join(rootDir, "bin");
  const logFile = path.join(rootDir, "commands.log");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logFile, "", "utf8");

  return {
    rootDir,
    homeDir,
    binDir,
    logFile,
    env: {
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MOCK_LOG: logFile,
    },
  };
}

export function cleanupSandbox(sandbox: ScriptSandbox): void {
  rmSync(sandbox.rootDir, { recursive: true, force: true });
}

export function writeMockCommand(
  sandbox: ScriptSandbox,
  name: string,
  body: string,
): string {
  const commandPath = path.join(sandbox.binDir, name);
  writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(commandPath, 0o755);
  return commandPath;
}

export function readCommandLog(sandbox: ScriptSandbox): string {
  return readFileSync(sandbox.logFile, "utf8");
}

export function runRepoScript(
  relativeScriptPath: string,
  args: string[],
  sandbox: ScriptSandbox,
  envOverrides: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const scriptPath = path.join(REPO_ROOT, relativeScriptPath);
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...sandbox.env,
      ...envOverrides,
    },
    encoding: "utf8",
  });
}

export function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}
