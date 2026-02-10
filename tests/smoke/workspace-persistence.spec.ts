import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

function successPayload<T>(data: T) {
  return JSON.stringify({ success: true, data });
}

async function fulfillSuccess<T>(route: Route, data: T) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: successPayload(data),
  });
}

async function setupWorkspaceApiMock(
  page: Page,
  options?: {
    invalidProjectPath?: boolean;
    counters?: {
      directoryListCalls: number;
      executeCalls: number;
      resumeCalls: number;
      agentExecuteCalls: number;
      agentResumeCalls: number;
    };
  }
) {
  const invalidProjectPath = options?.invalidProjectPath ?? false;

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/projects') {
      await fulfillSuccess(route, []);
      return;
    }

    if (path === '/api/agents/detected' || path === '/api/unknown/list_detected_agents') {
      await fulfillSuccess(route, []);
      return;
    }

    if (path.startsWith('/api/providers/') && path.endsWith('/runtime')) {
      await fulfillSuccess(route, {
        provider_id: 'claude',
        installed: true,
        auth_ready: true,
        ready: true,
        detected_binary: '/usr/bin/claude',
        detected_version: '1.0.0',
        issues: [],
        setup_hints: [],
      });
      return;
    }

    if (path === '/api/unknown/list_directory_contents') {
      if (options?.counters) {
        options.counters.directoryListCalls += 1;
      }
      if (invalidProjectPath) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Path invalid' }),
        });
        return;
      }
      await fulfillSuccess(route, []);
      return;
    }

    if (path === '/api/provider-sessions/execute') {
      if (options?.counters) {
        options.counters.executeCalls += 1;
      }
      await fulfillSuccess(route, { session_id: 'smoke-session-1' });
      return;
    }

    if (path === '/api/provider-sessions/resume') {
      if (options?.counters) {
        options.counters.resumeCalls += 1;
      }
      await fulfillSuccess(route, { session_id: 'smoke-session-1' });
      return;
    }

    if (path === '/api/unknown/execute_agent_session') {
      if (options?.counters) {
        options.counters.agentExecuteCalls += 1;
      }
      await fulfillSuccess(route, { session_id: 'smoke-session-1' });
      return;
    }

    if (path === '/api/unknown/resume_agent_session') {
      if (options?.counters) {
        options.counters.agentResumeCalls += 1;
      }
      await fulfillSuccess(route, { session_id: 'smoke-session-1' });
      return;
    }

    await fulfillSuccess(route, null);
  });
}

async function workspaceTabIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="workspace-tab-"]').evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-testid') || '')
      .filter((id) => id.length > 0)
  );
}

async function ensureWorkspaceCount(page: Page, count: number) {
  const newWorkspaceButton = page.getByTestId('workspace-new-project');
  await expect(newWorkspaceButton).toBeVisible();

  while ((await page.locator('[data-testid^="workspace-tab-"]').count()) < count) {
    await newWorkspaceButton.click();
  }
}

function activePromptInput(page: Page): Locator {
  return page.locator('textarea[placeholder*="Message"]:visible').first();
}

async function sendPrompt(page: Page, prompt: string): Promise<Locator> {
  const input = activePromptInput(page);
  await expect(input).toBeVisible();
  await input.fill(prompt);
  await expect(input).toHaveValue(prompt);

  const promptContainer = input.locator('xpath=ancestor::div[contains(@class,"relative")][1]');
  const sendButton = promptContainer
    .locator('button:has(svg.lucide-send):not([disabled])')
    .first();
  await expect(sendButton).toBeVisible();
  await sendButton.click();

  await expect(input).toHaveValue('');
  return input;
}

async function reorderFirstWorkspaceToLast(page: Page): Promise<string[]> {
  const idsBefore = await workspaceTabIds(page);
  expect(idsBefore.length).toBeGreaterThanOrEqual(3);
  const expected = [...idsBefore.slice(1), idsBefore[0]];

  const tabs = page.locator('[data-testid^="workspace-tab-"]');
  await tabs.first().dragTo(tabs.nth(idsBefore.length - 1));

  const idsAfterDragTo = await workspaceTabIds(page);
  if (JSON.stringify(idsAfterDragTo) === JSON.stringify(expected)) {
    return idsAfterDragTo;
  }

  const sourceBox = await tabs.first().boundingBox();
  const targetBox = await tabs.nth(idsBefore.length - 1).boundingBox();
  if (!sourceBox || !targetBox) {
    return idsAfterDragTo;
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width - 12, targetBox.y + targetBox.height / 2, { steps: 20 });
  await page.mouse.up();

  return workspaceTabIds(page);
}

async function installStreamingWebSocketMock(
  page: Page,
  options: {
    firstOutputDelayMs: number;
    completionDelayMs: number;
    commandCounters?: {
      executeCommands: number;
      resumeCommands: number;
    };
  }
) {
  await page.evaluate(({ firstOutputDelayMs, completionDelayMs, commandCounters }) => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(_url: string) {
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }, 0);
      }

      send(data: string) {
        if (commandCounters) {
          try {
            const payload = JSON.parse(data);
            if (payload?.command_type === 'execute') {
              commandCounters.executeCommands += 1;
            } else if (payload?.command_type === 'resume') {
              commandCounters.resumeCommands += 1;
            }
          } catch {
            // Ignore malformed payloads in smoke mocks.
          }
        }

        setTimeout(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'start', message: 'started' }),
            })
          );
        }, 10);

        setTimeout(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'output',
                content: JSON.stringify({
                  type: 'system',
                  subtype: 'init',
                  session_id: 'smoke-session-1',
                }),
              }),
            })
          );
        }, firstOutputDelayMs);

        setTimeout(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'completion', status: 'success' }),
            })
          );
        }, completionDelayMs);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'closed' }));
      }

      addEventListener() {}

      removeEventListener() {}
    }

    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  }, options);
}

test.describe('Workspace persistence smoke', () => {
  test('reorders workspace tabs and restores exact order after restart', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.goto('/');
    await page.addStyleTag({
      content: '*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }',
    });

    await ensureWorkspaceCount(page, 3);
    const before = await workspaceTabIds(page);
    expect(before.length).toBe(3);

    const after = await reorderFirstWorkspaceToLast(page);
    const expected = [...before.slice(1), before[0]];
    expect(after).toEqual(expected);

    await page.reload();
    await expect.poll(() => workspaceTabIds(page)).toEqual(expected);
  });

  test('restores terminal tabs and split panes after restart', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.goto('/');
    await page.addStyleTag({
      content: '*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }',
    });

    await ensureWorkspaceCount(page, 1);
    await page.getByTestId('workspace-new-terminal').click();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);

    await page.getByTitle('Split Right').first().click({ force: true });
    await expect(page.locator('[data-testid^="workspace-pane-"]:visible')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);
    await expect(page.locator('[data-testid^="workspace-pane-"]:visible')).toHaveCount(2);
  });

  test('restores active workspace and active terminal selection after restart', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.goto('/');
    await page.addStyleTag({
      content: '*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }',
    });

    await ensureWorkspaceCount(page, 2);
    await page.locator('[data-testid^="workspace-tab-"]').nth(1).click();

    await page.getByTestId('workspace-new-terminal').click();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);

    await page.locator('[data-testid^="terminal-tab-"]').nth(1).click();
    const visiblePaneLocator = page.locator('[data-testid^="workspace-pane-"]:visible');
    const paneCountBeforeSplit = await visiblePaneLocator.count();
    await page.getByTitle('Split Right').first().click({ force: true });
    await expect(visiblePaneLocator).toHaveCount(paneCountBeforeSplit + 1);

    await page.reload();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);
    await expect(page.locator('[data-testid^="workspace-pane-"]:visible')).toHaveCount(
      paneCountBeforeSplit + 1
    );
  });

  test.fixme('preserves terminal session metadata when switching terminal tabs', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.addInitScript(() => {
      localStorage.removeItem('opcode_workspace_v3');
      localStorage.removeItem('opcode_tabs_v2');
    });
    await page.goto('/');

    await ensureWorkspaceCount(page, 1);

    await page.evaluate(() => {
      const raw = localStorage.getItem('opcode_workspace_v3');
      if (!raw) {
        throw new Error('Workspace persistence payload is missing');
      }

      const parsed = JSON.parse(raw) as {
        tabs?: Array<{
          terminalTabs?: Array<{
            activePaneId?: string;
            sessionState?: Record<string, unknown>;
            paneStates?: Record<string, Record<string, unknown>>;
          }>;
        }>;
      };

      const workspace = parsed.tabs?.[0];
      const terminal = workspace?.terminalTabs?.[0];
      if (!workspace || !terminal || !terminal.activePaneId) {
        throw new Error('Expected initial workspace/terminal/pane to exist');
      }

      const sessionId = 'persisted-session-1';
      terminal.sessionState = {
        ...(terminal.sessionState || {}),
        sessionId,
        sessionData: {
          id: sessionId,
          project_id: 'smoke-project',
          project_path: '/tmp/codeinterfacex-smoke-project',
          created_at: Date.now(),
        },
      };
      terminal.paneStates = {
        ...(terminal.paneStates || {}),
        [terminal.activePaneId]: {
          ...((terminal.paneStates || {})[terminal.activePaneId] || {}),
          sessionId,
        },
      };

      localStorage.setItem('opcode_workspace_v3', JSON.stringify(parsed));
    });

    await page.reload();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(1);

    await page.getByTestId('workspace-new-terminal').click();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);

    await page.locator('[data-testid^="terminal-tab-"]').nth(1).click();
    await page.locator('[data-testid^="terminal-tab-"]').nth(0).click();

    const persistedSession = await page.evaluate(() => {
      const raw = localStorage.getItem('opcode_workspace_v3');
      if (!raw) return { sessionId: null as string | null, paneSessionId: null as string | null };
      const parsed = JSON.parse(raw) as {
        tabs?: Array<{
          terminalTabs?: Array<{
            activePaneId?: string;
            sessionState?: { sessionId?: string };
            paneStates?: Record<string, { sessionId?: string }>;
          }>;
        }>;
      };
      const terminal = parsed.tabs?.[0]?.terminalTabs?.[0];
      if (!terminal || !terminal.activePaneId) {
        return { sessionId: null as string | null, paneSessionId: null as string | null };
      }
      return {
        sessionId: terminal.sessionState?.sessionId ?? null,
        paneSessionId: terminal.paneStates?.[terminal.activePaneId]?.sessionId ?? null,
      };
    });

    expect(persistedSession.sessionId).toBe('persisted-session-1');
    expect(persistedSession.paneSessionId).toBe('persisted-session-1');
  });

  test('shows immediate preflight error for invalid project path', async ({ page }) => {
    const counters = {
      directoryListCalls: 0,
      executeCalls: 0,
      resumeCalls: 0,
      agentExecuteCalls: 0,
      agentResumeCalls: 0,
    };

    await setupWorkspaceApiMock(page, {
      invalidProjectPath: true,
      counters,
    });
    await page.addInitScript(() => {
      localStorage.setItem('codeinterfacex.smoke.projectPath', '/definitely/not/a/real/project/path');
    });
    await page.goto('/');

    await ensureWorkspaceCount(page, 1);
    await sendPrompt(page, 'hello');

    await expect.poll(() => counters.directoryListCalls).toBeGreaterThan(0);
    await expect.poll(() => counters.executeCalls).toBe(0);
    await expect.poll(() => counters.resumeCalls).toBe(0);
  });

  test('exits loading with deterministic error instead of infinite spinner', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.addInitScript(() => {
      localStorage.setItem('codeinterfacex.smoke.projectPath', '/tmp/codeinterfacex-smoke-project');
    });
    await page.goto('/');

    await ensureWorkspaceCount(page, 1);

    await page.evaluate(() => {
      class ErrorWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readyState = ErrorWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor(_url: string) {
          setTimeout(() => {
            this.readyState = ErrorWebSocket.OPEN;
            this.onopen?.(new Event('open'));
          }, 0);
        }

        send(_data: string) {
          setTimeout(() => {
            this.onerror?.(new Event('error'));
          }, 20);
        }

        close() {
          this.readyState = ErrorWebSocket.CLOSED;
          this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'closed' }));
        }

        addEventListener() {}

        removeEventListener() {}
      }

      (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = ErrorWebSocket as unknown as typeof WebSocket;
    });

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    const startedAt = Date.now();
    await sendPrompt(page, 'timeout test');
    await expect.poll(() =>
      consoleErrors.some((message) => message.includes('Failed to send prompt'))
    ).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_500);
    await expect(page.locator('.rotating-symbol')).toHaveCount(0);
  });

  test('does not show slow-start warning when first stream arrives quickly', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.addInitScript(() => {
      localStorage.setItem('codeinterfacex.smoke.projectPath', '/tmp/codeinterfacex-smoke-project');
    });
    await page.goto('/');
    await ensureWorkspaceCount(page, 1);

    await installStreamingWebSocketMock(page, {
      firstOutputDelayMs: 400,
      completionDelayMs: 900,
    });

    await sendPrompt(page, 'fast stream test');

    await expect(page.locator('.rotating-symbol')).toHaveCount(0, { timeout: 5000 });
    await expect(
      page.getByText(/No response yet \(2s\)\. Still waiting for provider startup\./i)
    ).toHaveCount(0);
  });
});
