import { expect, test, type Page, type Route } from "@playwright/test";

type AttentionDetail = {
  kind: "done" | "needs_input";
  workspaceId: string;
  terminalTabId: string;
  title: string;
  body: string;
  source: "provider_session" | "agent_execution" | "agent_run_output";
  timestamp: number;
};

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

async function setupAttentionApiMock(page: Page) {
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

    if (path === "/api/provider-sessions/execute" || path === "/api/provider-sessions/resume") {
      await fulfillSuccess(route, { session_id: "attention-session-1" });
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

async function dispatchAgentAttention(page: Page, detail: AttentionDetail) {
  await page.evaluate((eventDetail) => {
    window.dispatchEvent(
      new CustomEvent("opcode-agent-attention", {
        detail: eventDetail,
      })
    );
  }, detail);
}

test.describe("Agent attention smoke", () => {
  test.beforeEach(async ({ page }) => {
    await setupAttentionApiMock(page);
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
  });

  test("surfaces needs_input and done in terminal and workspace indicators", async ({ page }) => {
    const ids = await getWorkspaceAndTerminalIds(page);
    const terminalTab = page.locator(`[data-testid="terminal-tab-${ids.terminalTabIds[0]}"]`);
    const workspaceTab = page.locator(`[data-testid="workspace-tab-${ids.workspaceId}"]`);

    await dispatchAgentAttention(page, {
      kind: "needs_input",
      workspaceId: ids.workspaceId,
      terminalTabId: ids.terminalTabIds[0],
      title: "Needs input",
      body: "Please confirm whether I should proceed.",
      source: "provider_session",
      timestamp: Date.now(),
    });

    await expect(terminalTab.locator('[aria-label="Needs response"]')).toBeVisible();
    await expect(workspaceTab.locator('[aria-label="Needs response"]')).toBeVisible();

    await dispatchAgentAttention(page, {
      kind: "done",
      workspaceId: ids.workspaceId,
      terminalTabId: ids.terminalTabIds[0],
      title: "Done",
      body: "Run completed.",
      source: "provider_session",
      timestamp: Date.now() + 10,
    });

    await expect(terminalTab.locator('[aria-label="Needs check"]')).toBeVisible();
    await expect(workspaceTab.locator('[aria-label="Needs check"]')).toBeVisible();
  });

  test("clears terminal status on activate for attention and complete", async ({ page }) => {
    const ids = await getWorkspaceAndTerminalIds(page);
    const terminalTab = page.locator(`[data-testid="terminal-tab-${ids.terminalTabIds[0]}"]`);

    await dispatchAgentAttention(page, {
      kind: "needs_input",
      workspaceId: ids.workspaceId,
      terminalTabId: ids.terminalTabIds[0],
      title: "Needs input",
      body: "Please confirm.",
      source: "provider_session",
      timestamp: Date.now(),
    });
    await expect(terminalTab.locator('[aria-label="Needs response"]')).toBeVisible();
    await terminalTab.click();
    await expect(terminalTab.locator('[aria-label="Needs response"]')).toHaveCount(0);

    await dispatchAgentAttention(page, {
      kind: "done",
      workspaceId: ids.workspaceId,
      terminalTabId: ids.terminalTabIds[0],
      title: "Done",
      body: "Run completed.",
      source: "provider_session",
      timestamp: Date.now() + 10,
    });
    await expect(terminalTab.locator('[aria-label="Needs check"]')).toBeVisible();
    await terminalTab.click();
    await expect(terminalTab.locator('[aria-label="Needs check"]')).toHaveCount(0);
  });

  test("workspace aggregate prioritizes attention over complete and drops after clear", async ({
    page,
  }) => {
    await page.getByTestId("workspace-new-terminal").click();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);

    const ids = await getWorkspaceAndTerminalIds(page);
    const firstTerminalId = ids.terminalTabIds[0];
    const secondTerminalId = ids.terminalTabIds[1];

    const workspaceTab = page.locator(`[data-testid="workspace-tab-${ids.workspaceId}"]`);
    const secondTerminalTab = page.locator(`[data-testid="terminal-tab-${secondTerminalId}"]`);

    await dispatchAgentAttention(page, {
      kind: "done",
      workspaceId: ids.workspaceId,
      terminalTabId: firstTerminalId,
      title: "Done",
      body: "Terminal one complete.",
      source: "provider_session",
      timestamp: Date.now(),
    });

    await dispatchAgentAttention(page, {
      kind: "needs_input",
      workspaceId: ids.workspaceId,
      terminalTabId: secondTerminalId,
      title: "Needs input",
      body: "Terminal two needs a decision.",
      source: "provider_session",
      timestamp: Date.now() + 10,
    });

    await expect(workspaceTab.locator('[aria-label="Needs response"]')).toBeVisible();

    await secondTerminalTab.click();
    await expect(secondTerminalTab.locator('[aria-label="Needs response"]')).toHaveCount(0);
    await expect(workspaceTab.locator('[aria-label="Needs check"]')).toBeVisible();
  });
});
