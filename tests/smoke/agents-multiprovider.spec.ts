import { expect, test, type Page, type Route } from "@playwright/test";

type AgentRecord = {
  id: number;
  name: string;
  icon: string;
  system_prompt: string;
  default_task?: string;
  provider_id: string;
  model: string;
  created_at: string;
  updated_at: string;
};

type AgentRunRecord = {
  id: number;
  agent_id: number;
  agent_name: string;
  agent_icon: string;
  provider_id: string;
  task: string;
  model: string;
  project_path: string;
  session_id: string;
  output?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  pid?: number;
  process_started_at?: string;
  created_at: string;
  completed_at?: string;
  duration_ms?: number;
  total_tokens?: number;
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

async function setupApiMock(page: Page) {
  let nextAgentId = 1;
  let nextRunId = 1;
  const agents: AgentRecord[] = [];
  const runs: AgentRunRecord[] = [];

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const query = url.searchParams;
    const nowIso = () => new Date().toISOString();

    if (path === "/api/projects") {
      await fulfillSuccess(route, []);
      return;
    }

    if (path === "/api/agents/detected" || path === "/api/unknown/list_detected_agents") {
      await fulfillSuccess(route, []);
      return;
    }

    if (path === "/api/agents") {
      const name = query.get("name");
      const systemPrompt = query.get("systemPrompt");
      if (name || systemPrompt) {
        const providerId = query.get("providerId") || "claude";
        const model = query.get("model") ?? "";
        const createdAgent: AgentRecord = {
          id: nextAgentId++,
          name: name || `Agent ${nextAgentId}`,
          icon: query.get("icon") || "bot",
          system_prompt: systemPrompt || "",
          default_task: query.get("defaultTask") || undefined,
          provider_id: providerId,
          model,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        agents.push(createdAgent);
        await fulfillSuccess(route, createdAgent);
        return;
      }

      await fulfillSuccess(route, agents);
      return;
    }

    const updateAgentMatch = path.match(/^\/api\/agents\/(\d+)$/);
    if (updateAgentMatch) {
      const id = Number(updateAgentMatch[1]);
      const existing = agents.find((agent) => agent.id === id);
      if (!existing) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Agent not found" }),
        });
        return;
      }

      const updated: AgentRecord = {
        ...existing,
        name: query.get("name") || existing.name,
        icon: query.get("icon") || existing.icon,
        system_prompt: query.get("systemPrompt") || existing.system_prompt,
        default_task: query.get("defaultTask") || existing.default_task,
        provider_id: query.get("providerId") || existing.provider_id,
        model: query.get("model") ?? existing.model,
        updated_at: nowIso(),
      };
      const idx = agents.findIndex((agent) => agent.id === id);
      agents[idx] = updated;
      await fulfillSuccess(route, updated);
      return;
    }

    if (path === "/api/agents/runs" || path === "/api/agents/runs/metrics") {
      const maybeAgentId = query.get("agentId");
      const filteredRuns = maybeAgentId
        ? runs.filter((run) => run.agent_id === Number(maybeAgentId))
        : runs;
      await fulfillSuccess(route, filteredRuns);
      return;
    }

    const executeMatch = path.match(/^\/api\/agents\/(\d+)\/execute$/);
    if (executeMatch) {
      const agentId = Number(executeMatch[1]);
      const agent = agents.find((entry) => entry.id === agentId);
      if (!agent) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: "Agent not found" }),
        });
        return;
      }

      const runId = nextRunId++;
      const run: AgentRunRecord = {
        id: runId,
        agent_id: agent.id,
        agent_name: agent.name,
        agent_icon: agent.icon,
        provider_id: agent.provider_id,
        task: query.get("task") || "Smoke run",
        model: query.get("model") || agent.model || "",
        project_path: query.get("projectPath") || "/tmp",
        session_id: `smoke-session-${runId}`,
        status: "running",
        created_at: nowIso(),
      };
      runs.unshift(run);
      await fulfillSuccess(route, runId);
      return;
    }

    const killMatch = path.match(/^\/api\/agents\/sessions\/(\d+)\/kill$/);
    if (killMatch) {
      const runId = Number(killMatch[1]);
      const run = runs.find((entry) => entry.id === runId);
      if (!run) {
        await fulfillSuccess(route, false);
        return;
      }
      run.status = "cancelled";
      run.completed_at = nowIso();
      run.output = `Cancelled ${run.agent_name}`;
      await fulfillSuccess(route, true);
      return;
    }

    const statusMatch = path.match(/^\/api\/agents\/sessions\/(\d+)\/status$/);
    if (statusMatch) {
      const runId = Number(statusMatch[1]);
      const run = runs.find((entry) => entry.id === runId);
      await fulfillSuccess(route, run?.status ?? null);
      return;
    }

    const outputMatch = path.match(/^\/api\/agents\/sessions\/(\d+)\/output$/);
    if (outputMatch) {
      const runId = Number(outputMatch[1]);
      const run = runs.find((entry) => entry.id === runId);
      await fulfillSuccess(route, run?.output || "");
      return;
    }

    await fulfillSuccess(route, null);
  });
}

test.describe("Multiprovider agent smoke", () => {
  test("create -> run -> cancel -> history works for Claude/Codex/Gemini", async ({ page }) => {
    await setupApiMock(page);
    await page.addInitScript(() => {
      localStorage.setItem("opcode.smoke.projectPath", "/tmp/opcode-smoke-project");
    });

    await page.goto("/");
    await page.addStyleTag({
      content: "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }",
    });

    await expect(page.getByTestId("titlebar-agents-button")).toBeVisible();
    await page.getByTestId("titlebar-agents-button").click();
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

    const providers = [
      { id: "claude", modelLabel: "Default (recommended)" },
      { id: "codex", modelLabel: "GPT-5.3-Codex" },
      { id: "gemini", modelLabel: "Provider Default" },
    ];

    for (const provider of providers) {
      const agentName = `Smoke ${provider.id}`;
      const systemPrompt = `You are a ${provider.id} smoke test agent.`;

      await page.getByTestId("titlebar-agents-button").click();
      await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
      await page.getByTestId("agents-tab-agents").click();
      await page.getByTestId("agents-create-button").click();

      await page.locator("#name").fill(agentName);
      await page.getByTestId("create-agent-provider-select").selectOption(provider.id);
      await expect(page.getByText(provider.modelLabel).first()).toBeVisible();
      await page.locator("#default-task").fill(`Smoke task for ${provider.id}`);
      await page.locator('[data-testid="create-agent-system-prompt"] textarea').first().fill(systemPrompt);
      await page.getByTestId("create-agent-save-button").click();

      const agentCard = page.locator('[data-testid^="agent-card-"]').filter({ hasText: agentName }).first();
      await expect(agentCard).toBeVisible();
      await agentCard.getByRole("button", { name: "Run" }).click();

      await expect(page.getByText(provider.modelLabel).last()).toBeVisible();
      const taskInput = page.locator('[data-testid="agent-task-input"]:visible');
      const executeButton = page.locator('[data-testid="agent-execute-button"]:visible');
      const stopButton = page.locator('[data-testid="agent-stop-button"]:visible');
      await taskInput.fill(`Smoke task for ${provider.id}`);
      await expect(taskInput).toHaveValue(`Smoke task for ${provider.id}`);

      await executeButton.click();
      await expect(stopButton).toBeVisible();
      await stopButton.click();
      await expect(executeButton).toBeVisible();

      await page.getByTestId("titlebar-agents-button").click();
      await page.getByTestId("agents-tab-history").click();

      const historyRun = page.locator('[data-testid^="agents-history-run-"]').filter({ hasText: agentName }).first();
      await expect(historyRun).toBeVisible({ timeout: 12_000 });
      await expect(historyRun.getByText("cancelled")).toBeVisible();
    }
  });
});
