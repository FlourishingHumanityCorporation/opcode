import { expect, test, type Page, type Route } from "@playwright/test";

interface TerminalTelemetry {
  startedTerminalIds: string[];
  writes: Array<{ terminalId: string; data: string }>;
}

interface TerminalApiMockOptions {
  failInput?: (request: { terminalId: string; data: string; attempt: number }) => string | null;
}

function successPayload<T>(data: T) {
  return JSON.stringify({ success: true, data });
}

async function fulfillSuccess<T>(route: Route, data: T) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: successPayload(data),
  });
}

async function fulfillError(route: Route, message: string) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: false, error: message }),
  });
}

async function setupTerminalApiMock(
  page: Page,
  telemetry: TerminalTelemetry,
  options: TerminalApiMockOptions = {}
) {
  let inputAttempt = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/projects") {
      await fulfillSuccess(route, []);
      return;
    }

    if (path === "/api/agents/detected" || path === "/api/unknown/list_detected_agents") {
      await fulfillSuccess(route, []);
      return;
    }

    if (path.startsWith("/api/storage/tables/")) {
      await fulfillSuccess(route, { data: [] });
      return;
    }

    if (path === "/api/unknown/list_directory_contents") {
      await fulfillSuccess(route, []);
      return;
    }

    if (path === "/api/terminal/start") {
      const terminalId = `smoke-terminal-${telemetry.startedTerminalIds.length + 1}`;
      telemetry.startedTerminalIds.push(terminalId);
      await fulfillSuccess(route, {
        terminalId,
        reusedExistingSession: false,
      });
      return;
    }

    if (path === "/api/terminal/input") {
      const request = {
        terminalId: url.searchParams.get("terminalId") || "",
        data: url.searchParams.get("data") || "",
        attempt: inputAttempt,
      };
      inputAttempt += 1;
      telemetry.writes.push({
        terminalId: request.terminalId,
        data: request.data,
      });
      const inputError = options.failInput?.(request);
      if (inputError) {
        await fulfillError(route, inputError);
        return;
      }
      await fulfillSuccess(route, null);
      return;
    }

    if (path === "/api/terminal/resize" || path === "/api/terminal/close") {
      await fulfillSuccess(route, null);
      return;
    }

    await fulfillSuccess(route, null);
  });
}

async function bootstrapWorkspaceWithNativeTerminal(page: Page) {
  await page.goto("/");
  await page.addStyleTag({
    content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }",
  });

  await expect(page.getByTestId("empty-new-project")).toBeVisible();
  await page.getByTestId("empty-new-project").click();
  await expect(page.locator('[data-testid^="workspace-tab-"]')).toHaveCount(1);
  await installFakeTauriEventBridge(page);
  const workspaceOpenProject = page.locator('[data-testid="workspace-open-project"]:visible').first();
  await expect(workspaceOpenProject).toBeVisible();
  await workspaceOpenProject.click();
}

async function installFakeTauriEventBridge(page: Page) {
  await page.evaluate(() => {
    let nextCallbackId = 1;
    let nextListenerId = 1;
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    const listeners = new Map<number, { event: string; callbackId: number }>();

    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: (event: { payload: unknown }) => void) {
        const callbackId = nextCallbackId++;
        callbacks.set(callbackId, callback);
        return callbackId;
      },
      async invoke(command: string, args?: { event?: string; eventId?: number; handler?: number }) {
        if (command === "plugin:event|listen") {
          const eventId = nextListenerId++;
          listeners.set(eventId, {
            event: String(args?.event || ""),
            callbackId: Number(args?.handler || 0),
          });
          return eventId;
        }

        if (command === "plugin:event|unlisten") {
          listeners.delete(Number(args?.eventId || 0));
          return null;
        }

        return null;
      },
    };

    (window as any).__OPCODE_SMOKE_EMIT_TAURI_EVENT__ = (eventName: string, payload: unknown) => {
      listeners.forEach((listener) => {
        if (listener.event !== eventName) {
          return;
        }
        const callback = callbacks.get(listener.callbackId);
        callback?.({ payload });
      });
    };
  });
}

test.describe("Terminal immediate typing smoke", () => {
  test("new terminal accepts immediate typing without extra terminal click", async ({ page }) => {
    const telemetry: TerminalTelemetry = {
      startedTerminalIds: [],
      writes: [],
    };

    await setupTerminalApiMock(page, telemetry);
    await page.addInitScript(() => {
      localStorage.removeItem("opcode_workspace_v3");
      localStorage.removeItem("opcode_tabs_v2");
      localStorage.setItem("opcode.smoke.projectPath", "/tmp/opcode-smoke-project");
      localStorage.setItem("native_terminal_mode", "true");
      localStorage.setItem("app_setting:native_terminal_mode", "true");
    });

    await bootstrapWorkspaceWithNativeTerminal(page);

    await expect.poll(() => telemetry.startedTerminalIds.length > 0).toBe(true);
    await expect(page.getByText("Running").first()).toBeVisible();

    const startsBeforeNewTerminal = telemetry.startedTerminalIds.length;
    await page.getByTestId("workspace-new-terminal").click();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);

    await expect.poll(() => telemetry.startedTerminalIds.length >= startsBeforeNewTerminal + 1).toBe(true);
    const newTerminalId = telemetry.startedTerminalIds[telemetry.startedTerminalIds.length - 1];

    await page.keyboard.type("abc");

    await expect.poll(() => {
      const writesForNewTerminal = telemetry.writes
        .filter((entry) => entry.terminalId === newTerminalId)
        .map((entry) => entry.data)
        .join("");
      return writesForNewTerminal;
    }).toContain("abc");
  });

  test("routes typing to active terminal when stale xterm helper focus remains on previous terminal", async ({
    page,
  }) => {
    const telemetry: TerminalTelemetry = {
      startedTerminalIds: [],
      writes: [],
    };

    await setupTerminalApiMock(page, telemetry);
    await page.addInitScript(() => {
      localStorage.removeItem("opcode_workspace_v3");
      localStorage.removeItem("opcode_tabs_v2");
      localStorage.setItem("opcode.smoke.projectPath", "/tmp/opcode-smoke-project");
      localStorage.setItem("native_terminal_mode", "true");
      localStorage.setItem("app_setting:native_terminal_mode", "true");
    });

    await bootstrapWorkspaceWithNativeTerminal(page);
    await expect.poll(() => telemetry.startedTerminalIds.length > 0).toBe(true);
    const firstTerminalId = telemetry.startedTerminalIds[0];

    await page.getByTestId("workspace-new-terminal").click();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);
    await expect.poll(() => telemetry.startedTerminalIds.length >= 2).toBe(true);
    const secondTerminalId = telemetry.startedTerminalIds[telemetry.startedTerminalIds.length - 1];

    await page.evaluate(() => {
      const staleHelper = document.createElement("textarea");
      staleHelper.className = "xterm-helper-textarea";
      staleHelper.setAttribute("data-testid", "smoke-stale-helper");
      document.body.appendChild(staleHelper);
      staleHelper.focus();
    });

    await page.keyboard.type("switch-ok");

    await expect.poll(() => {
      const writesForSecond = telemetry.writes
        .filter((entry) => entry.terminalId === secondTerminalId)
        .map((entry) => entry.data)
        .join("");
      return writesForSecond;
    }).toContain("switch-ok");
    expect(
      telemetry.writes
        .filter((entry) => entry.terminalId === firstTerminalId)
        .map((entry) => entry.data)
        .join("")
    ).not.toContain("switch-ok");

    await page.evaluate(() => {
      document.querySelector('[data-testid="smoke-stale-helper"]')?.remove();
    });
  });

  test("recovers from stale runtime terminal id when persistent session restore is active", async ({
    page,
  }) => {
    const telemetry: TerminalTelemetry = {
      startedTerminalIds: [],
      writes: [],
    };

    let staleTerminalId: string | null = null;
    let sessionNotFoundFailures = 0;
    await setupTerminalApiMock(page, telemetry, {
      failInput: ({ terminalId }) => {
        if (
          staleTerminalId &&
          terminalId === staleTerminalId &&
          sessionNotFoundFailures < 4
        ) {
          sessionNotFoundFailures += 1;
          return "ERR_SESSION_NOT_FOUND: Terminal session not found";
        }
        return null;
      },
    });

    await page.addInitScript(() => {
      localStorage.removeItem("opcode_workspace_v3");
      localStorage.removeItem("opcode_tabs_v2");
      localStorage.setItem("opcode.smoke.projectPath", "/tmp/opcode-smoke-project");
      localStorage.setItem("native_terminal_mode", "true");
      localStorage.setItem("app_setting:native_terminal_mode", "true");
    });

    await bootstrapWorkspaceWithNativeTerminal(page);
    await expect.poll(() => telemetry.startedTerminalIds.length > 0).toBe(true);

    const initialStarts = telemetry.startedTerminalIds.length;
    staleTerminalId = telemetry.startedTerminalIds[initialStarts - 1];

    await page.getByTitle("Run claude").first().click();
    await expect.poll(() => {
      return telemetry.writes.some(
        (entry) => entry.terminalId === staleTerminalId && entry.data.includes("claude")
      );
    }).toBe(true);

    await expect
      .poll(
        () => telemetry.startedTerminalIds.length,
        {
          timeout: 12_000,
        }
      )
      .toBeGreaterThan(initialStarts);

    const recoveredTerminalId = telemetry.startedTerminalIds[telemetry.startedTerminalIds.length - 1];
    expect(recoveredTerminalId).not.toBe(staleTerminalId);

    await page.keyboard.type("recovery-ok");
    await expect.poll(() => {
      const writesForRecoveredTerminal = telemetry.writes
        .filter((entry) => entry.terminalId === recoveredTerminalId)
        .map((entry) => entry.data)
        .join("");
      return writesForRecoveredTerminal;
    }).toContain("recovery-ok");

    const writesForStaleTerminal = telemetry.writes
      .filter((entry) => entry.terminalId === staleTerminalId)
      .map((entry) => entry.data)
      .join("");
    expect(writesForStaleTerminal).not.toContain("recovery-ok");

    await page.getByTitle("Run claude").first().click();
    await expect.poll(() => {
      return telemetry.writes.some(
        (entry) => entry.terminalId === recoveredTerminalId && entry.data.includes("claude")
      );
    }).toBe(true);
  });

  test("staged recovery escalates only after write failures and reattaches terminal", async ({ page }) => {
    const telemetry: TerminalTelemetry = {
      startedTerminalIds: [],
      writes: [],
    };

    let failedEmptyWrites = 0;
    await setupTerminalApiMock(page, telemetry, {
      failInput: ({ data }) => {
        if (data === "" && failedEmptyWrites < 2) {
          failedEmptyWrites += 1;
          return "ERR_WRITE_FAILED: Simulated healthcheck stall";
        }
        return null;
      },
    });

    await page.addInitScript(() => {
      localStorage.removeItem("opcode_workspace_v3");
      localStorage.removeItem("opcode_tabs_v2");
      localStorage.setItem("opcode.smoke.projectPath", "/tmp/opcode-smoke-project");
      localStorage.setItem("native_terminal_mode", "true");
      localStorage.setItem("app_setting:native_terminal_mode", "true");
    });

    await bootstrapWorkspaceWithNativeTerminal(page);
    await expect.poll(() => telemetry.startedTerminalIds.length).toBeGreaterThan(0);
    const initialStarts = telemetry.startedTerminalIds.length;
    const activeTerminalId = telemetry.startedTerminalIds[initialStarts - 1];

    await page.getByTitle("Run claude").first().click();
    await expect.poll(() => {
      return telemetry.writes.some(
        (entry) => entry.terminalId === activeTerminalId && entry.data.includes("claude")
      );
    }).toBe(true);

    await expect.poll(
      () => telemetry.startedTerminalIds.length,
      {
        timeout: 18_000,
      }
    ).toBeGreaterThan(initialStarts);
    expect(failedEmptyWrites).toBeGreaterThanOrEqual(2);
  });
});
