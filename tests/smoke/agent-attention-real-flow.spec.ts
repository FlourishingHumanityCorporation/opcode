import { expect, test, type Page, type Route } from "@playwright/test";

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

async function setupAttentionApiMock(page: Page, sessionId: string) {
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

    if (path === "/api/provider-sessions/running") {
      await fulfillSuccess(route, [
        {
          process_type: {
            ProviderSession: {
              session_id: sessionId,
            },
          },
        },
      ]);
      return;
    }

    if (path.startsWith(`/api/provider-sessions/${sessionId}/history/`)) {
      await fulfillSuccess(route, []);
      return;
    }

    if (path === "/api/provider-sessions/execute" || path === "/api/provider-sessions/resume") {
      await fulfillSuccess(route, { session_id: sessionId });
      return;
    }

    await fulfillSuccess(route, null);
  });
}

async function ensureWorkspaceCount(page: Page, count: number) {
  const newWorkspaceButton = page.getByTestId("workspace-new-project");
  await expect(newWorkspaceButton).toBeVisible();

  while ((await page.locator('[data-testid^="workspace-tab-"]').count()) < count) {
    await newWorkspaceButton.click();
  }
}

async function getWorkspaceAndTerminalIds(page: Page): Promise<{
  workspaceId: string;
  terminalTabIds: string[];
}> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("opcode_workspace_v3");
    if (!raw) {
      throw new Error("Missing opcode_workspace_v3");
    }

    const parsed = JSON.parse(raw) as {
      tabs?: Array<{ id?: string; terminalTabs?: Array<{ id?: string }> }>;
    };

    const workspace = parsed.tabs?.[0];
    const workspaceId = workspace?.id;
    const terminalTabIds = (workspace?.terminalTabs || [])
      .map((terminal) => terminal.id)
      .filter((id): id is string => Boolean(id));

    if (!workspaceId || terminalTabIds.length === 0) {
      throw new Error("Missing workspace or terminal ids");
    }

    return { workspaceId, terminalTabIds };
  });
}

async function getActiveTerminalId(page: Page, workspaceId: string): Promise<string> {
  return page.evaluate((targetWorkspaceId) => {
    const raw = localStorage.getItem("opcode_workspace_v3");
    if (!raw) {
      throw new Error("Missing opcode_workspace_v3");
    }
    const parsed = JSON.parse(raw) as {
      tabs?: Array<{ id?: string; activeTerminalTabId?: string | null }>;
    };
    const workspace = parsed.tabs?.find((tab) => tab.id === targetWorkspaceId);
    if (!workspace?.activeTerminalTabId) {
      throw new Error("Missing active terminal id");
    }
    return workspace.activeTerminalTabId;
  }, workspaceId);
}

async function waitForSessionHydrated(
  page: Page,
  workspaceId: string,
  sessionId: string
): Promise<void> {
  await page.waitForFunction(
    ({ targetWorkspaceId, targetSessionId }) => {
      const raw = localStorage.getItem("opcode_workspace_v3");
      if (!raw) {
        return false;
      }
      const parsed = JSON.parse(raw) as {
        tabs?: Array<{
          id?: string;
          terminalTabs?: Array<{
            sessionState?: {
              sessionData?: {
                id?: string;
              };
            };
          }>;
        }>;
      };
      const workspace = parsed.tabs?.find((tab) => tab.id === targetWorkspaceId);
      if (!workspace?.terminalTabs) {
        return false;
      }
      return workspace.terminalTabs.some(
        (terminal) => terminal.sessionState?.sessionData?.id === targetSessionId
      );
    },
    { targetWorkspaceId: workspaceId, targetSessionId: sessionId },
    { timeout: 15000 }
  );
}

async function dispatchProviderEvent(page: Page, eventName: string, payload: unknown) {
  await page.evaluate(
    ({ nextEventName, nextPayload }) => {
      window.dispatchEvent(
        new CustomEvent(nextEventName, {
          detail: nextPayload,
        })
      );
    },
    { nextEventName: eventName, nextPayload: payload }
  );
}

async function dispatchOpenSession(page: Page, sessionId: string, projectPath: string) {
  await page.evaluate(
    ({ nextSessionId, nextProjectPath }) => {
      window.dispatchEvent(
        new CustomEvent("open-session-in-tab", {
          detail: {
            session: {
              id: nextSessionId,
              project_id: "attention-project",
              project_path: nextProjectPath,
            },
          },
        })
      );
    },
    { nextSessionId: sessionId, nextProjectPath: projectPath }
  );
}

test.describe("Agent attention real stream flow smoke", () => {
  test("emits needs_input and done through provider stream events", async ({ page }) => {
    const sessionId = "attention-real-flow-1";
    await setupAttentionApiMock(page, sessionId);
    await page.addInitScript(() => {
      localStorage.removeItem("opcode_workspace_v3");
      localStorage.removeItem("opcode_tabs_v2");
      localStorage.setItem("opcode.smoke.projectPath", "/tmp/opcode-smoke-project");
    });

    await page.goto("/");
    await page.addStyleTag({
      content:
        "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }",
    });
    await ensureWorkspaceCount(page, 1);

    const ids = await getWorkspaceAndTerminalIds(page);
    const workspaceTab = page.locator(`[data-testid="workspace-tab-${ids.workspaceId}"]`);

    await dispatchOpenSession(page, sessionId, "/tmp/opcode-smoke-project");
    await page.waitForTimeout(250);
    await dispatchOpenSession(page, sessionId, "/tmp/opcode-smoke-project");
    await waitForSessionHydrated(page, ids.workspaceId, sessionId);

    await page.waitForTimeout(1200);
    const activeTerminalId = await getActiveTerminalId(page, ids.workspaceId);
    const terminalTab = page.locator(`[data-testid="terminal-tab-${activeTerminalId}"]`);

    await dispatchProviderEvent(page, `provider-session-output:${sessionId}`, {
      type: "system",
      subtype: "event",
      item: {
        type: "tool_use",
        name: "request_user_input",
        input: {
          questions: [
            {
              header: "Decision",
              question: "Should I proceed with the migration?",
            },
          ],
        },
      },
    });

    await expect(terminalTab.locator('[aria-label="Needs response"]')).toBeVisible();
    await expect(workspaceTab.locator('[aria-label="Needs response"]')).toBeVisible();

    await dispatchProviderEvent(page, `provider-session-complete:${sessionId}`, {
      status: "success",
      success: true,
      session_id: sessionId,
      provider_id: "claude",
    });

    await expect(terminalTab.locator('[aria-label="Needs check"]')).toBeVisible();
    await expect(workspaceTab.locator('[aria-label="Needs check"]')).toBeVisible();
  });
});
