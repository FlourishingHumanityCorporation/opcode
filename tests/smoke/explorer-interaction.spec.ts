import { expect, test, type Page, type Route } from "@playwright/test";

type DirectoryFixture = Record<string, Array<{
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  extension?: string;
}>>;

interface NativeTelemetry {
  startedTerminalIds: string[];
}

const PROJECT_PATH = "/tmp/codeinterfacex-smoke-project";

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

function fileEntry(path: string, name: string, extension?: string) {
  return {
    name,
    path,
    is_directory: false,
    size: 1,
    extension,
  };
}

function dirEntry(path: string, name: string) {
  return {
    name,
    path,
    is_directory: true,
    size: 0,
  };
}

function buildDirectoryFixture(projectPath: string): DirectoryFixture {
  const rootFolders = Array.from({ length: 80 }, (_, index) => {
    const name = `folder-${String(index + 1).padStart(3, "0")}`;
    return dirEntry(`${projectPath}/${name}`, name);
  });

  const rootFiles = Array.from({ length: 60 }, (_, index) => {
    const name = `file-${String(index + 1).padStart(3, "0")}.md`;
    return fileEntry(`${projectPath}/${name}`, name, "md");
  });

  return {
    [projectPath]: [
      dirEntry(`${projectPath}/backend`, "backend"),
      dirEntry(`${projectPath}/frontend`, "frontend"),
      ...rootFolders,
      ...rootFiles,
    ],
    [`${projectPath}/backend`]: [
      fileEntry(`${projectPath}/backend/main.py`, "main.py", "py"),
      dirEntry(`${projectPath}/backend/src`, "src"),
    ],
    [`${projectPath}/backend/src`]: [
      fileEntry(`${projectPath}/backend/src/routes.py`, "routes.py", "py"),
    ],
    [`${projectPath}/frontend`]: [
      fileEntry(`${projectPath}/frontend/index.tsx`, "index.tsx", "tsx"),
    ],
  };
}

async function setupExplorerApiMock(
  page: Page,
  fixture: DirectoryFixture,
  options: { nativeMode: boolean; telemetry?: NativeTelemetry }
) {
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

    if (path.startsWith("/api/providers/") && path.endsWith("/runtime")) {
      await fulfillSuccess(route, {
        provider_id: "claude",
        installed: true,
        auth_ready: true,
        ready: true,
        detected_binary: "/usr/bin/claude",
        detected_version: "1.0.0",
        issues: [],
        setup_hints: [],
      });
      return;
    }

    if (path === "/api/unknown/list_directory_contents") {
      const directoryPath = url.searchParams.get("directoryPath") || "";
      await fulfillSuccess(route, fixture[directoryPath] || []);
      return;
    }

    if (options.nativeMode && path === "/api/terminal/start") {
      const telemetry = options.telemetry;
      if (!telemetry) {
        await fulfillSuccess(route, { terminalId: "smoke-terminal-1", reusedExistingSession: false });
        return;
      }
      const terminalId = `smoke-terminal-${telemetry.startedTerminalIds.length + 1}`;
      telemetry.startedTerminalIds.push(terminalId);
      await fulfillSuccess(route, { terminalId, reusedExistingSession: false });
      return;
    }

    if (options.nativeMode && (path === "/api/terminal/input" || path === "/api/terminal/resize" || path === "/api/terminal/close")) {
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

    (window as any).__CODEINTERFACEX_SMOKE_EMIT_TAURI_EVENT__ = (eventName: string, payload: unknown) => {
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

async function bootstrapWorkspace(page: Page, options: { nativeMode: boolean }) {
  await page.addInitScript(({ projectPath, nativeMode }) => {
    localStorage.clear();
    localStorage.setItem("codeinterfacex.smoke.projectPath", projectPath);
    if (nativeMode) {
      localStorage.setItem("native_terminal_mode", "true");
      localStorage.setItem("app_setting:native_terminal_mode", "true");
    } else {
      localStorage.removeItem("native_terminal_mode");
      localStorage.removeItem("app_setting:native_terminal_mode");
    }
  }, { projectPath: PROJECT_PATH, nativeMode: options.nativeMode });

  await page.goto("/");
  await page.addStyleTag({
    content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }",
  });

  await expect(page.getByTestId("empty-new-project")).toBeVisible();
  await page.getByTestId("empty-new-project").click();
  await expect(page.locator('[data-testid^="workspace-tab-"]')).toHaveCount(1);

  if (options.nativeMode) {
    await installFakeTauriEventBridge(page);
  }

  await page.locator('[data-testid="workspace-open-project"]:visible').first().click();

  await expect(page.getByTestId("project-explorer-root")).toBeVisible();
  await expect(page.locator(`[data-entry-path="${PROJECT_PATH}/backend"]`).first()).toBeVisible();
}

async function ensureBackendExpanded(page: Page) {
  const backendRow = page.locator(`[data-entry-path="${PROJECT_PATH}/backend"]`).first();
  const backendChild = page.locator(`[data-entry-path="${PROJECT_PATH}/backend/main.py"]`).first();
  await backendRow.scrollIntoViewIfNeeded();
  await expect(backendRow).toBeVisible();

  if ((await backendChild.count()) === 0 || !(await backendChild.isVisible().catch(() => false))) {
    await backendRow.click();
  }
  await expect(backendChild).toBeVisible();
  await backendRow.scrollIntoViewIfNeeded();
}

async function seamClick(page: Page) {
  const backendRow = page.locator(`[data-entry-path="${PROJECT_PATH}/backend"]`).first();
  await backendRow.scrollIntoViewIfNeeded();
  await expect(backendRow).toBeVisible();
  const box = await backendRow.boundingBox();
  if (!box) {
    throw new Error("Failed to compute backend row bounds");
  }
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
}

async function assertSeamHitInsideExplorer(page: Page) {
  const backendRow = page.locator(`[data-entry-path="${PROJECT_PATH}/backend"]`).first();
  await backendRow.scrollIntoViewIfNeeded();
  await expect(backendRow).toBeVisible();
  const box = await backendRow.boundingBox();
  if (!box) {
    throw new Error("Failed to compute backend row bounds");
  }

  const seamPoint = { x: box.x + box.width - 4, y: box.y + box.height / 2 };
  const hit = await page.evaluate((point) => {
    const target = document.elementFromPoint(point.x, point.y);
    if (!(target instanceof Element)) {
      return null;
    }

    return {
      insideExplorer: Boolean(target.closest('[data-testid="project-explorer-scroll"]')),
      insideSplitPaneLeft: Boolean(target.closest('[data-testid="split-pane-left"]')),
      insideSplitPaneRight: Boolean(target.closest('[data-testid="split-pane-right"]')),
      insideTerminal: Boolean(target.closest(".xterm")),
    };
  }, seamPoint);

  expect(hit).not.toBeNull();
  expect(hit?.insideExplorer).toBe(true);
  expect(hit?.insideSplitPaneLeft).toBe(true);
  expect(hit?.insideSplitPaneRight).toBe(false);
  expect(hit?.insideTerminal).toBe(false);
}

async function assertExplorerScrolls(page: Page) {
  const explorerScroll = page.getByTestId("project-explorer-scroll");
  await expect(explorerScroll).toBeVisible();

  const initialScrollTop = await explorerScroll.evaluate((element) => element.scrollTop);
  await explorerScroll.hover();
  await page.mouse.wheel(0, 1200);

  await expect
    .poll(() => explorerScroll.evaluate((element) => element.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(initialScrollTop);
}

async function toggleExplorerOffOn(page: Page) {
  const toggle = page.locator('[data-testid^="workspace-toggle-explorer-"]:visible').first();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("title", "Hide explorer");
  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Show explorer");
  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Hide explorer");
  await expect(page.getByTestId("project-explorer-root")).toBeVisible();
}

test.describe("Explorer interaction smoke", () => {
  test("web mode: explorer rows remain clickable and wheel scroll works after toggling", async ({ page }) => {
    const fixture = buildDirectoryFixture(PROJECT_PATH);
    await setupExplorerApiMock(page, fixture, { nativeMode: false });
    await bootstrapWorkspace(page, { nativeMode: false });

    await ensureBackendExpanded(page);
    await assertExplorerScrolls(page);
    await toggleExplorerOffOn(page);

    await ensureBackendExpanded(page);
    await assertSeamHitInsideExplorer(page);
    await seamClick(page);
    await expect.poll(() => page.locator(`[data-entry-path="${PROJECT_PATH}/backend/main.py"]`).count()).toBe(0);
    await seamClick(page);
    await expect(page.locator(`[data-entry-path="${PROJECT_PATH}/backend/main.py"]`).first()).toBeVisible();
  });

  test("native mode: explorer remains clickable and wheel scroll works while terminal is running", async ({ page }) => {
    const telemetry: NativeTelemetry = { startedTerminalIds: [] };
    const fixture = buildDirectoryFixture(PROJECT_PATH);
    await setupExplorerApiMock(page, fixture, { nativeMode: true, telemetry });
    await bootstrapWorkspace(page, { nativeMode: true });

    await expect.poll(() => telemetry.startedTerminalIds.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const terminalId = telemetry.startedTerminalIds[telemetry.startedTerminalIds.length - 1];
    await page.evaluate((id) => {
      const emit = (window as any).__CODEINTERFACEX_SMOKE_EMIT_TAURI_EVENT__ as
        | ((eventName: string, payload: unknown) => void)
        | undefined;
      if (!emit) {
        return;
      }
      for (let line = 0; line < 80; line += 1) {
        emit(`terminal-output:${id}`, `native-line-${line}\r\n`);
      }
    }, terminalId);

    await ensureBackendExpanded(page);
    await assertExplorerScrolls(page);
    await assertSeamHitInsideExplorer(page);
    await seamClick(page);
    await expect.poll(() => page.locator(`[data-entry-path="${PROJECT_PATH}/backend/main.py"]`).count()).toBe(0);
    await seamClick(page);
    await expect(page.locator(`[data-entry-path="${PROJECT_PATH}/backend/main.py"]`).first()).toBeVisible();
  });
});
