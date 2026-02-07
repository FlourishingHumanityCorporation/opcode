import { expect, test, type Page, type Route } from '@playwright/test';

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

async function setupWorkspaceApiMock(page: Page, options?: { invalidProjectPath?: boolean }) {
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
  options: { firstOutputDelayMs: number; completionDelayMs: number }
) {
  await page.evaluate(({ firstOutputDelayMs, completionDelayMs }) => {
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

      send(_data: string) {
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

    await page.getByTitle('Split Right').first().click();
    await expect(page.locator('[data-testid^="workspace-pane-"]')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('[data-testid^="terminal-tab-"]')).toHaveCount(2);
    await expect(page.locator('[data-testid^="workspace-pane-"]')).toHaveCount(2);
  });

  test('shows immediate preflight error for invalid project path', async ({ page }) => {
    await setupWorkspaceApiMock(page, { invalidProjectPath: true });
    await page.addInitScript(() => {
      localStorage.setItem('opcode.smoke.projectPath', '/definitely/not/a/real/project/path');
    });
    await page.goto('/');

    await ensureWorkspaceCount(page, 1);
    const input = page.getByPlaceholder(/Message .* \(.*\)\.\.\./i).first();
    await input.fill('hello');
    await input.press('Enter');

    await expect(page.getByText(/Project path is invalid or inaccessible/i)).toBeVisible();
  });

  test('exits loading with deterministic error instead of infinite spinner', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.addInitScript(() => {
      localStorage.setItem('opcode.smoke.projectPath', '/tmp/opcode-smoke-project');
    });
    await page.goto('/');

    await ensureWorkspaceCount(page, 1);

    await page.evaluate(() => {
      class SilentWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readyState = SilentWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor(_url: string) {
          setTimeout(() => {
            this.readyState = SilentWebSocket.OPEN;
            this.onopen?.(new Event('open'));
          }, 0);
        }

        send(_data: string) {}

        close() {
          this.readyState = SilentWebSocket.CLOSED;
          this.onclose?.(new CloseEvent('close', { code: 1000, reason: 'closed' }));
        }

        addEventListener() {}

        removeEventListener() {}
      }

      (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = SilentWebSocket as unknown as typeof WebSocket;
    });

    const input = page.getByPlaceholder(/Message .* \(.*\)\.\.\./i).first();
    await input.fill('timeout test');
    const startedAt = Date.now();
    await input.press('Enter');

    await expect(page.getByText(/No response yet \(2s\)|Failed to send prompt/i)).toBeVisible({
      timeout: 5_000,
    });
    expect(Date.now() - startedAt).toBeLessThan(3_500);
    await expect(page.locator('.rotating-symbol')).toHaveCount(0);
  });

  test('does not show slow-start warning when first stream arrives quickly', async ({ page }) => {
    await setupWorkspaceApiMock(page);
    await page.addInitScript(() => {
      localStorage.setItem('opcode.smoke.projectPath', '/tmp/opcode-smoke-project');
    });
    await page.goto('/');
    await ensureWorkspaceCount(page, 1);

    await installStreamingWebSocketMock(page, {
      firstOutputDelayMs: 400,
      completionDelayMs: 900,
    });

    const input = page.getByPlaceholder(/Message .* \(.*\)\.\.\./i).first();
    await input.fill('fast stream test');
    await input.press('Enter');

    await expect(page.locator('.rotating-symbol')).toHaveCount(0, { timeout: 5000 });
    await expect(
      page.getByText(/No response yet \(2s\)\. Still waiting for provider startup\./i)
    ).toHaveCount(0);
  });
});
