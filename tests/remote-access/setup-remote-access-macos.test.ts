import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupSandbox,
  createSandbox,
  readCommandLog,
  runRepoScript,
  type ScriptSandbox,
  writeMockCommand,
} from "./testHarness";

const sandboxes: ScriptSandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox) {
      cleanupSandbox(sandbox);
    }
  }
});

function newSandbox(): ScriptSandbox {
  const sandbox = createSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}

function addCoreMocks(sandbox: ScriptSandbox): void {
  writeMockCommand(sandbox, "mock_uname", `echo "Darwin"`);
  writeMockCommand(sandbox, "mock_npm", `echo "mock_npm $*" >> "$MOCK_LOG"`);
  writeMockCommand(sandbox, "mock_cargo", `echo "mock_cargo $*" >> "$MOCK_LOG"`);
  writeMockCommand(sandbox, "mock_launchctl", `echo "mock_launchctl $*" >> "$MOCK_LOG"`);
  writeMockCommand(
    sandbox,
    "mock_ipconfig",
    `
if [[ "$1" == "getifaddr" ]]; then
  echo "10.0.0.52"
  exit 0
fi
`,
  );
}

function addBrewAndTailscaleMocks(
  sandbox: ScriptSandbox,
  options: {
    brewHasTailscale: boolean;
    tailscaleStatusExitCode: number;
    tailscaleIp?: string;
  },
): void {
  const prefixDir = path.join(sandbox.rootDir, "tailscale-prefix");
  const prefixBinDir = path.join(prefixDir, "bin");
  mkdirSync(prefixBinDir, { recursive: true });

  writeMockCommand(
    sandbox,
    "mock_brew",
    `
echo "mock_brew $*" >> "$MOCK_LOG"
if [[ "$1" == "list" && "$2" == "tailscale" ]]; then
  ${
    options.brewHasTailscale
      ? "exit 0"
      : "exit 1"
  }
fi
if [[ "$1" == "--prefix" && "$2" == "tailscale" ]]; then
  echo "${prefixDir}"
  exit 0
fi
exit 0
`,
  );

  writeMockCommand(
    {
      ...sandbox,
      binDir: prefixBinDir,
    },
    "tailscale",
    `
echo "mock_tailscale $*" >> "$MOCK_LOG"
if [[ "$*" == *" status"* ]]; then
  ${
    options.tailscaleStatusExitCode === 0
      ? `echo "Running"`
      : `echo "Logged out."`
  }
  exit ${options.tailscaleStatusExitCode}
fi
if [[ "$*" == *" ip -4"* ]]; then
  echo "${options.tailscaleIp ?? ""}"
  exit 0
fi
exit 0
`,
  );

  writeMockCommand(
    {
      ...sandbox,
      binDir: prefixBinDir,
    },
    "tailscaled",
    `echo "mock_tailscaled $*" >> "$MOCK_LOG"`,
  );
}

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    UNAME_BIN: "mock_uname",
    NPM_BIN: "mock_npm",
    CARGO_BIN: "mock_cargo",
    LAUNCHCTL_BIN: "mock_launchctl",
    BREW_BIN: "mock_brew",
    IPCONFIG_BIN: "mock_ipconfig",
    ...overrides,
  };
}

describe("setup-remote-access-macos.sh", () => {
  it("writes plists, injects port, and configures launch agents", () => {
    const sandbox = newSandbox();
    addCoreMocks(sandbox);
    addBrewAndTailscaleMocks(sandbox, {
      brewHasTailscale: true,
      tailscaleStatusExitCode: 1,
    });

    const result = runRepoScript(
      "scripts/setup-remote-access-macos.sh",
      ["8090"],
      sandbox,
      baseEnv(),
    );

    expect(result.status).toBe(0);
    const stdout = result.stdout ?? "";
    expect(stdout).toContain("CodeInterfaceX web URL (local): http://127.0.0.1:8090");
    expect(stdout).toContain("CodeInterfaceX web URL (LAN):   http://10.0.0.52:8090");
    expect(stdout).toContain("Tailscale needs login. Run:");

    const opcodePlist = path.join(
      sandbox.homeDir,
      "Library/LaunchAgents/com.codeinterfacex.web.plist",
    );
    const tailscalePlist = path.join(
      sandbox.homeDir,
      "Library/LaunchAgents/com.codeinterfacex.tailscaled-userspace.plist",
    );
    expect(existsSync(opcodePlist)).toBe(true);
    expect(existsSync(tailscalePlist)).toBe(true);

    const opcodePlistContent = readFileSync(opcodePlist, "utf8");
    const tailscalePlistContent = readFileSync(tailscalePlist, "utf8");
    expect(opcodePlistContent).toContain("<string>8090</string>");
    expect(opcodePlistContent).toContain("<string>com.codeinterfacex.web</string>");
    expect(tailscalePlistContent).toContain("<string>com.codeinterfacex.tailscaled-userspace</string>");

    const commandLog = readCommandLog(sandbox);
    expect(commandLog).toContain("mock_launchctl bootstrap");
    expect(commandLog).toContain("com.codeinterfacex.web.plist");
    expect(commandLog).toContain("com.codeinterfacex.tailscaled-userspace.plist");
  });

  it("fails with clear guidance when Homebrew is unavailable", () => {
    const sandbox = newSandbox();
    addCoreMocks(sandbox);

    const result = runRepoScript(
      "scripts/setup-remote-access-macos.sh",
      ["8090"],
      sandbox,
      baseEnv(),
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Homebrew is required to install Tailscale.",
    );
  });

  it("installs tailscale when brew list reports it missing", () => {
    const sandbox = newSandbox();
    addCoreMocks(sandbox);
    addBrewAndTailscaleMocks(sandbox, {
      brewHasTailscale: false,
      tailscaleStatusExitCode: 1,
    });

    const result = runRepoScript(
      "scripts/setup-remote-access-macos.sh",
      ["8090"],
      sandbox,
      baseEnv(),
    );

    expect(result.status).toBe(0);
    const commandLog = readCommandLog(sandbox);
    expect(commandLog).toContain("mock_brew list tailscale");
    expect(commandLog).toContain("mock_brew install tailscale");
  });

  it("prints tailnet URL when tailscale status succeeds", () => {
    const sandbox = newSandbox();
    addCoreMocks(sandbox);
    addBrewAndTailscaleMocks(sandbox, {
      brewHasTailscale: true,
      tailscaleStatusExitCode: 0,
      tailscaleIp: "100.64.1.99",
    });

    const result = runRepoScript(
      "scripts/setup-remote-access-macos.sh",
      ["8090"],
      sandbox,
      baseEnv(),
    );

    expect(result.status).toBe(0);
    expect(result.stdout ?? "").toContain(
      "CodeInterfaceX web URL (tailnet): http://100.64.1.99:8090",
    );
  });
});
