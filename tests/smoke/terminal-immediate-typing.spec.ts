import { expect, test, type Page, type Route } from "@playwright/test";

interface TerminalTelemetry {
  startedTerminalIds: string[];
  writes: Array<{ terminalId: string; data: string }>;
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

async function setupTerminalApiMock(page: Page, telemetry: TerminalTelemetry) {
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
      telemetry.writes.push({
        terminalId: url.searchParams.get("terminalId") || "",
        data: url.searchParams.get("data") || "",
      });
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
});
