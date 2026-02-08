import { expect, test, type Page, type Route } from "@playwright/test";

type TitleRequestTelemetry = {
  transcript: string;
  model: string;
};

type AutoRenameTelemetry = {
  titleGenerationCallCount: number;
  lastTitleRequest: TitleRequestTelemetry | null;
};

type AutoRenameMockOptions = {
  projectPath?: string;
  projectId?: string;
  sessionId?: string;
  generatedTitle?: string;
  titleResponseDelayMs?: number;
  sessionHistory?: unknown[];
};

const DEFAULT_PROJECT_PATH = "/Users/paulrohde/CodeProjects/apps/MeetingMind";
const DEFAULT_PROJECT_ID = "project-meetingmind";
const DEFAULT_SESSION_ID = "session-active-1";

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

function defaultSessionHistory(): unknown[] {
  return [
    {
      type: "user",
      message: { content: "Check VP transcribe CLI help for available flags in MeetingMind." },
    },
    {
      type: "assistant",
      message: { content: "I will inspect the CLI flags and summarize the verified result." },
    },
    {
      type: "user",
      message: { content: "Validate speaker embedding persistence path and summarize pass/fail." },
    },
  ];
}

async function setupNativeAutoRenameApiMock(
  page: Page,
  telemetry: AutoRenameTelemetry,
  options: AutoRenameMockOptions = {}
) {
  const projectPath = options.projectPath || DEFAULT_PROJECT_PATH;
  const projectId = options.projectId || DEFAULT_PROJECT_ID;
  const sessionId = options.sessionId || DEFAULT_SESSION_ID;
  const generatedTitle = options.generatedTitle ?? "MeetingMind: Speaker Embedding Persistence Fix";
  const titleResponseDelayMs = options.titleResponseDelayMs ?? 0;
  const sessionHistory = options.sessionHistory || defaultSessionHistory();

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/projects") {
      await fulfillSuccess(route, [
        {
          id: projectId,
          path: projectPath,
          sessions: [sessionId],
          created_at: Date.now(),
        },
      ]);
      return;
    }

    if (path === `/api/projects/${encodeURIComponent(projectId)}/sessions`) {
      await fulfillSuccess(route, [
        {
          id: sessionId,
          project_id: projectId,
          project_path: projectPath,
          created_at: Date.now(),
          first_message: "Smoke session",
        },
      ]);
      return;
    }

    if (
      path ===
      `/api/provider-sessions/${encodeURIComponent(sessionId)}/history/${encodeURIComponent(projectId)}`
    ) {
      await fulfillSuccess(route, sessionHistory);
      return;
    }

    if (path === "/api/terminal/title") {
      telemetry.titleGenerationCallCount += 1;
      telemetry.lastTitleRequest = {
        transcript: url.searchParams.get("transcript") || "",
        model: url.searchParams.get("model") || "",
      };

      if (titleResponseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, titleResponseDelayMs));
      }

      await fulfillSuccess(route, generatedTitle);
      return;
    }

    if (path === "/api/agents/detected" || path === "/api/unknown/list_detected_agents") {
      await fulfillSuccess(route, []);
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
      await fulfillSuccess(route, []);
      return;
    }

    if (path === "/api/terminal/start") {
      await fulfillSuccess(route, {
        terminalId: "smoke-native-terminal-1",
        reusedExistingSession: false,
      });
      return;
    }

    if (
      path === "/api/terminal/input" ||
      path === "/api/terminal/resize" ||
      path === "/api/terminal/close"
    ) {
      await fulfillSuccess(route, null);
      return;
    }

    if (path.startsWith("/api/storage/tables/")) {
      await fulfillSuccess(route, { data: [] });
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

async function bootstrapNativeWorkspace(page: Page, projectPath = DEFAULT_PROJECT_PATH) {
  await page.addInitScript((initialProjectPath) => {
    localStorage.removeItem("opcode_workspace_v3");
    localStorage.removeItem("opcode_tabs_v2");
    localStorage.setItem("opcode.smoke.projectPath", initialProjectPath);
    localStorage.setItem("native_terminal_mode", "true");
    localStorage.setItem("app_setting:native_terminal_mode", "true");
  }, projectPath);

  await page.goto("/");
  await page.addStyleTag({
    content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }",
  });

  await expect(page.getByTestId("empty-new-project")).toBeVisible();
  await page.getByTestId("empty-new-project").click();
  await expect(page.locator('[data-testid^="workspace-tab-"]')).toHaveCount(1);

  await installFakeTauriEventBridge(page);

  const openProjectButton = page.locator('[data-testid="workspace-open-project"]:visible').first();
  await expect(openProjectButton).toBeVisible();
  await openProjectButton.click();

  await expect(page.getByText("Running").first()).toBeVisible();
  await expect(page.locator('[data-testid^="terminal-tab-"]').first()).toBeVisible();
}

test.describe("Native auto-rename smoke", () => {
  test("renames active native terminal from transcript context", async ({ page }) => {
    const telemetry: AutoRenameTelemetry = {
      titleGenerationCallCount: 0,
      lastTitleRequest: null,
    };

    await setupNativeAutoRenameApiMock(page, telemetry, {
      generatedTitle: "MeetingMind: Speaker Embedding Persistence Fix",
    });

    await bootstrapNativeWorkspace(page);

    const activeTab = page.locator('[data-testid^="terminal-tab-"]').first();

    await expect(activeTab).toContainText("Speaker Embedding Persistence Fix");
    await expect(activeTab).not.toContainText("MeetingMind");

    await expect.poll(() => telemetry.titleGenerationCallCount).toBe(1);
    expect(telemetry.lastTitleRequest?.model).toBe("glm-4.7-flash");
    expect(telemetry.lastTitleRequest?.transcript).toContain("USER:");
    expect(telemetry.lastTitleRequest?.transcript).toContain("Check VP transcribe CLI help");
  });

  test("does not apply rename while title lock is enabled", async ({ page }) => {
    const telemetry: AutoRenameTelemetry = {
      titleGenerationCallCount: 0,
      lastTitleRequest: null,
    };

    await setupNativeAutoRenameApiMock(page, telemetry, {
      generatedTitle: "MeetingMind: Calendar Selection Fix",
      titleResponseDelayMs: 1200,
    });

    await bootstrapNativeWorkspace(page);

    const activeTab = page.locator('[data-testid^="terminal-tab-"]').first();
    const lockButton = activeTab.getByRole("button", { name: "Lock title" });

    await expect(lockButton).toBeVisible();
    await lockButton.click();
    await expect(activeTab.getByRole("button", { name: "Unlock title" })).toBeVisible();

    await expect.poll(() => telemetry.titleGenerationCallCount).toBe(1);
    await page.waitForTimeout(1400);

    await expect(activeTab).toContainText("Terminal 1");
    await expect(activeTab).not.toContainText("Calendar Selection Fix");
  });

  test("skips repeat title generation when transcript has not changed", async ({ page }) => {
    test.slow();

    const telemetry: AutoRenameTelemetry = {
      titleGenerationCallCount: 0,
      lastTitleRequest: null,
    };

    await setupNativeAutoRenameApiMock(page, telemetry, {
      generatedTitle: "Terminal 1",
    });

    await bootstrapNativeWorkspace(page);

    await expect.poll(() => telemetry.titleGenerationCallCount).toBe(1);
    await page.waitForTimeout(16_500);

    expect(telemetry.titleGenerationCallCount).toBe(1);
  });
});
