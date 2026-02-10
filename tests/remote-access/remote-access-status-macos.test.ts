import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupSandbox,
  createSandbox,
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

function addCommonMocks(sandbox: ScriptSandbox): void {
  writeMockCommand(sandbox, "mock_uname", `echo "Darwin"`);
  writeMockCommand(
    sandbox,
    "mock_launchctl",
    `
if [[ "$1" == "print" ]]; then
  case "$2" in
    *com.codeinterfacex.web|*com.codeinterfacex.tailscaled-userspace)
      exit 1
      ;;
    *com.paulrohde.codeinterfacex-web)
      cat <<OUT
path = /Users/paulrohde/Library/LaunchAgents/com.paulrohde.codeinterfacex-web.plist
state = running
pid = 111
OUT
      exit 0
      ;;
    *com.paulrohde.tailscaled-userspace)
      cat <<OUT
path = /Users/paulrohde/Library/LaunchAgents/com.paulrohde.tailscaled-userspace.plist
state = running
pid = 222
OUT
      exit 0
      ;;
  esac
fi
exit 0
`,
  );
  writeMockCommand(
    sandbox,
    "mock_lsof",
    `
cat <<OUT
COMMAND     PID      USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
codeinterfacex-we 12345 user      9u  IPv4 0x1      0t0  TCP *:8090 (LISTEN)
OUT
`,
  );
  writeMockCommand(
    sandbox,
    "mock_ipconfig",
    `
if [[ "$1" == "getifaddr" ]]; then
  echo "10.0.0.77"
  exit 0
fi
`,
  );
  writeMockCommand(
    sandbox,
    "mock_curl",
    `
if [[ "$*" == *"http://127.0.0.1:8090/api/projects"* ]]; then
  echo '{"success":true,"data":[{"id":"local"}]}'
  exit 0
fi
if [[ "$*" == *"http://10.0.0.77:8090/api/projects"* ]]; then
  echo '{"success":true,"data":[{"id":"lan"}]}'
  exit 0
fi
echo '{"success":false,"error":"unexpected url"}'
exit 1
`,
  );
}

describe("remote-access-status-macos.sh", () => {
  it("reports legacy launchd labels and local+LAN health output", () => {
    const sandbox = newSandbox();
    addCommonMocks(sandbox);
    writeMockCommand(
      sandbox,
      "mock_tailscale",
      `
if [[ "$*" == *" status"* ]]; then
  echo "Logged out."
  exit 1
fi
if [[ "$*" == *" ip -4"* ]]; then
  echo "no current Tailscale IPs; state: NeedsLogin"
  exit 1
fi
exit 0
`,
    );

    const result = runRepoScript(
      "scripts/remote-access-status-macos.sh",
      ["8090"],
      sandbox,
      {
        UNAME_BIN: "mock_uname",
        LAUNCHCTL_BIN: "mock_launchctl",
        LSOF_BIN: "mock_lsof",
        CURL_BIN: "mock_curl",
        IPCONFIG_BIN: "mock_ipconfig",
        TAILSCALE_BIN: "mock_tailscale",
      },
    );

    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("com.paulrohde.codeinterfacex-web.plist");
    expect(output).toContain("com.paulrohde.tailscaled-userspace.plist");
    expect(output).toContain('{"success":true,"data":[{"id":"local"}]}');
    expect(output).toContain('{"success":true,"data":[{"id":"lan"}]}');
    expect(output).toContain("Logged out.");
  });

  it("degrades gracefully when tailscale CLI is unavailable", () => {
    const sandbox = newSandbox();
    addCommonMocks(sandbox);

    const result = runRepoScript(
      "scripts/remote-access-status-macos.sh",
      ["8090"],
      sandbox,
      {
        UNAME_BIN: "mock_uname",
        LAUNCHCTL_BIN: "mock_launchctl",
        LSOF_BIN: "mock_lsof",
        CURL_BIN: "mock_curl",
        IPCONFIG_BIN: "mock_ipconfig",
        TAILSCALE_BIN: "mock_tailscale",
      },
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("tailscale CLI not found");
  });
});
