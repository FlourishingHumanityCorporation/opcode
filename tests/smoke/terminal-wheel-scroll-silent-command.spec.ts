import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

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

async function bootstrapWorkspaceWithNativeTerminal(page: Page) {
  await page.goto("/");
  const disableAnimationCss =
    "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }";
  try {
    await page.addStyleTag({ content: disableAnimationCss });
  } catch {
    await page.waitForLoadState("domcontentloaded");
    await page.addStyleTag({ content: disableAnimationCss });
  }

  await expect(page.getByTestId("empty-new-project")).toBeVisible();
  await page.getByTestId("empty-new-project").click();
  await expect(page.locator('[data-testid^="workspace-tab-"]')).toHaveCount(1);
  await installFakeTauriEventBridge(page);
  const workspaceOpenProject = page.locator('[data-testid="workspace-open-project"]:visible').first();
  await expect(workspaceOpenProject).toBeVisible();
  await workspaceOpenProject.click();
}

async function seedTerminalOutput(page: Page, terminalId: string, lines = 420) {
  await page.evaluate(
    ({ id, count }) => {
      const emit = (window as any).__OPCODE_SMOKE_EMIT_TAURI_EVENT__ as
        | ((eventName: string, payload: unknown) => void)
        | undefined;
      if (!emit) {
        throw new Error("Smoke event bridge unavailable");
      }
      for (let line = 0; line < count; line += 1) {
        emit(`terminal-output:${id}`, `scroll-line-${line}\\r\\n`);
      }
    },
    { id: terminalId, count: lines }
  );
}

async function seedTerminalOutputForAll(page: Page, terminalIds: string[], lines = 420) {
  for (const terminalId of terminalIds) {
    await seedTerminalOutput(page, terminalId, lines);
  }
}

async function getFirstVisibleScrollLine(paneRoot: Locator): Promise<number | null> {
  return paneRoot.evaluate((root) => {
    const linePattern = /scroll-line-(\d+)/;
    const rows = Array.from(root.querySelectorAll(".xterm-rows > div"));
    for (const row of rows) {
      const text = row.textContent;
      if (!text) {
        continue;
      }
      const match = text.match(linePattern);
      if (match) {
        return Number(match[1]);
      }
    }
    return null;
  });
}

async function moveMouseToScreen(page: Page, screen: Locator, verticalRatio = 0.5) {
  const box = await screen.boundingBox();
  if (!box) {
    throw new Error("Failed to resolve xterm screen bounds");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height * verticalRatio;
  await page.mouse.move(x, y);
}

async function clearTerminalFrontendEvents(page: Page) {
  await page.evaluate(async () => {
    const diagnostics = await import("/src/services/terminalHangDiagnostics.ts");
    diagnostics.clearTerminalEventSnapshot();
  });
}

async function getTerminalFrontendEventNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const diagnostics = await import("/src/services/terminalHangDiagnostics.ts");
    return diagnostics.getTerminalEventSnapshot().map((event) => event.event);
  });
}

async function installScreenWheelBlocker(screen: Locator) {
  await screen.evaluate((screenNode) => {
    const blocker = (event: WheelEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    (screenNode as any).__opcodeSmokeWheelBlocker = blocker;
    screenNode.addEventListener("wheel", blocker, {
      capture: true,
      passive: false,
    });
  });
}

async function removeScreenWheelBlocker(screen: Locator) {
  await screen.evaluate((screenNode) => {
    const blocker = (screenNode as any).__opcodeSmokeWheelBlocker as
      | ((event: WheelEvent) => void)
      | undefined;
    if (blocker) {
      screenNode.removeEventListener("wheel", blocker, true);
      delete (screenNode as any).__opcodeSmokeWheelBlocker;
    }
  });
}

async function assertWheelScrollWorksWhileSilentCommand(params: {
  page: Page;
  paneRoot: Locator;
  screen: Locator;
  telemetry: TerminalTelemetry;
}) {
  const { page, paneRoot, screen, telemetry } = params;

  await expect
    .poll(
      async () => {
        const line = await getFirstVisibleScrollLine(paneRoot);
        return line ?? -1;
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThan(100);

  const baselineFirstVisibleLine = await getFirstVisibleScrollLine(paneRoot);
  expect(baselineFirstVisibleLine).not.toBeNull();

  const writesBeforeRun = telemetry.writes.length;
  await paneRoot.getByTitle("Run claude").first().click();
  let activePaneTerminalId: string | null = null;
  await expect.poll(() => {
    const runWrite = telemetry.writes
      .slice(writesBeforeRun)
      .find((entry) => entry.data.includes("claude"));
    activePaneTerminalId = runWrite?.terminalId ?? null;
    return Boolean(activePaneTerminalId);
  }).toBe(true);

  await moveMouseToScreen(page, screen, 0.5);
  await page.mouse.wheel(0, -900);
  await page.mouse.wheel(0, -900);

  await expect
    .poll(async () => {
      const line = await getFirstVisibleScrollLine(paneRoot);
      return line ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(baselineFirstVisibleLine ?? Number.POSITIVE_INFINITY);

  const afterWheelUpLine = await getFirstVisibleScrollLine(paneRoot);
  expect(afterWheelUpLine).not.toBeNull();

  // Exercise lower-edge scrolling to verify bottom native terminal strip does not intercept wheel.
  await moveMouseToScreen(page, screen, 0.92);
  await page.mouse.wheel(0, 900);
  await page.mouse.wheel(0, 900);

  await expect
    .poll(async () => {
      const line = await getFirstVisibleScrollLine(paneRoot);
      return line ?? -1;
    })
    .toBeGreaterThan(afterWheelUpLine ?? -1);
}

test.describe("Terminal wheel scroll smoke", () => {
  test("single-pane: wheel scrolling remains functional while command runs silently", async ({
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
    await expect.poll(() => telemetry.startedTerminalIds.length).toBeGreaterThan(0);
    const terminalId = telemetry.startedTerminalIds[telemetry.startedTerminalIds.length - 1];

    await seedTerminalOutput(page, terminalId);

    const pane = page.locator('[data-testid^="workspace-pane-"]:visible').first();
    const screen = pane.locator(".xterm-screen").first();
    await expect(screen).toBeVisible();

    await assertWheelScrollWorksWhileSilentCommand({
      page,
      paneRoot: pane,
      screen,
      telemetry,
    });
  });

  test("split-pane: active pane keeps wheel scrolling while command runs silently", async ({
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
    await expect.poll(() => telemetry.startedTerminalIds.length).toBeGreaterThan(0);
    const startsBeforeSplit = telemetry.startedTerminalIds.length;

    await page.getByTitle("Split Right").first().click({ force: true });
    await expect(page.locator('[data-testid^="workspace-pane-"]:visible')).toHaveCount(2);
    await expect
      .poll(() => telemetry.startedTerminalIds.length, { timeout: 15_000 })
      .toBeGreaterThan(startsBeforeSplit);

    await seedTerminalOutputForAll(page, [...telemetry.startedTerminalIds]);

    const activePane = page.locator('[data-testid^="workspace-pane-"]:visible').last();
    await activePane.click();

    const screen = activePane.locator(".xterm-screen").first();
    await expect(screen).toBeVisible();

    await assertWheelScrollWorksWhileSilentCommand({
      page,
      paneRoot: activePane,
      screen,
      telemetry,
    });
  });

  test("single-pane: emits fallback telemetry when native wheel handling is blocked", async ({
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
    await expect.poll(() => telemetry.startedTerminalIds.length).toBeGreaterThan(0);
    const terminalId = telemetry.startedTerminalIds[telemetry.startedTerminalIds.length - 1];

    await seedTerminalOutput(page, terminalId);

    const pane = page.locator('[data-testid^="workspace-pane-"]:visible').first();
    const screen = pane.locator(".xterm-screen").first();
    await expect(screen).toBeVisible();

    await clearTerminalFrontendEvents(page);
    await installScreenWheelBlocker(screen);

    try {
      await moveMouseToScreen(page, screen, 0.5);
      await page.mouse.wheel(0, -900);
      await page.mouse.wheel(0, -900);

      await expect
        .poll(async () => {
          const events = await getTerminalFrontendEventNames(page);
          return events.filter((event) => event === "wheel_fallback_scroll").length;
        })
        .toBeGreaterThan(0);
    } finally {
      await removeScreenWheelBlocker(screen);
    }
  });
});
