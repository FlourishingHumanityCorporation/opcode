import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStoreState = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStoreState.delete(key);
  }),
}));

import {
  clearStoredCredentials,
  loadStoredCredentials,
  persistCredentials,
  useSyncStore,
} from './syncStore';

function resetStore() {
  const initial = (useSyncStore as any).getInitialState?.();
  if (initial) {
    (useSyncStore as any).setState(initial, true);
    return;
  }

  useSyncStore.getState().resetRuntimeState();
  useSyncStore.getState().clearCredentials();
  useSyncStore.getState().setConnectionError(null);
}

describe('syncStore', () => {
  beforeEach(() => {
    secureStoreState.clear();
    vi.clearAllMocks();
    resetStore();
  });

  it('persists and loads credentials from secure store', async () => {
    const credentials = {
      deviceId: 'device-1',
      token: 'token-1',
      baseUrl: 'http://100.64.0.1:8091/mobile/v1',
      wsUrl: 'ws://100.64.0.1:8091/mobile/v1/ws',
    };

    await persistCredentials(credentials);
    const loaded = await loadStoredCredentials();

    expect(loaded).toEqual(credentials);

    await clearStoredCredentials();
    const cleared = await loadStoredCredentials();
    expect(cleared).toBeNull();
  });

  it('drops stale events and applies newer workspace summary payloads', () => {
    useSyncStore.getState().setSnapshot({
      version: 1,
      sequence: 10,
      generatedAt: '2026-02-09T00:00:00.000Z',
      state: {
        activeTabId: 'workspace-1',
        utilityOverlay: null,
        tabs: [
          {
            id: 'workspace-1',
            title: 'Repo A',
            projectPath: '/tmp/repo-a',
            activeTerminalTabId: 'terminal-1',
            terminalTabs: [],
          },
        ],
      },
    });

    useSyncStore.getState().appendEvent({
      version: 1,
      sequence: 10,
      eventType: 'workspace.state_changed',
      generatedAt: '2026-02-09T00:00:01.000Z',
      payload: {
        activeWorkspaceId: 'workspace-ignored',
      },
    });

    expect(useSyncStore.getState().mirror?.activeContext.activeWorkspaceId).toBe('workspace-1');

    useSyncStore.getState().appendEvent({
      version: 1,
      sequence: 11,
      eventType: 'workspace.state_changed',
      generatedAt: '2026-02-09T00:00:02.000Z',
      payload: {
        activeTabId: 'workspace-2',
        activeWorkspaceId: 'workspace-2',
        activeTerminalTabId: 'terminal-2',
        activeEmbeddedTerminalId: 'embedded-2',
        activeSessionId: 'session-2',
        projectPath: '/tmp/repo-b',
        workspaceCount: 2,
        terminalCount: 3,
      },
    });

    const state = useSyncStore.getState();
    expect(state.lastSequence).toBe(11);
    expect(state.mirror?.activeContext.activeWorkspaceId).toBe('workspace-2');
    expect(state.mirror?.activeContext.activeTerminalTabId).toBe('terminal-2');
    expect(state.mirror?.activeContext.activeEmbeddedTerminalId).toBe('embedded-2');
    expect(state.mirror?.activeContext.activeSessionId).toBe('session-2');
    expect(state.mirror?.activeContext.projectPath).toBe('/tmp/repo-b');
  });

  it('flags resnapshot_required and clears flag after snapshot set', () => {
    useSyncStore.getState().appendEvent({
      version: 1,
      sequence: 1,
      eventType: 'sync.resnapshot_required',
      generatedAt: '2026-02-09T00:00:03.000Z',
      payload: {
        reason: 'sequence_gap',
      },
    });

    expect(useSyncStore.getState().needsSnapshotRefresh).toBe(true);

    useSyncStore.getState().setSnapshot({
      version: 1,
      sequence: 2,
      generatedAt: '2026-02-09T00:00:04.000Z',
      state: {
        activeTabId: null,
        tabs: [],
      },
    });

    expect(useSyncStore.getState().needsSnapshotRefresh).toBe(false);
  });

  it('applies terminal and provider summary events idempotently', () => {
    useSyncStore.getState().setSnapshot({
      version: 1,
      sequence: 5,
      generatedAt: '2026-02-09T00:00:00.000Z',
      state: {
        activeTabId: null,
        tabs: [],
      },
    });

    useSyncStore.getState().appendEvent({
      version: 1,
      sequence: 6,
      eventType: 'terminal.state_summary',
      generatedAt: '2026-02-09T00:00:01.000Z',
      payload: {
        activeWorkspaceId: 'workspace-10',
        activeTerminalTabId: 'terminal-10',
        activeEmbeddedTerminalId: 'embedded-10',
      },
    });

    useSyncStore.getState().appendEvent({
      version: 1,
      sequence: 7,
      eventType: 'provider_session.state_summary',
      generatedAt: '2026-02-09T00:00:02.000Z',
      payload: {
        activeWorkspaceId: 'workspace-10',
        activeTerminalTabId: 'terminal-10',
        activeSessionId: 'session-10',
        projectPath: '/tmp/repo-10',
      },
    });

    const state = useSyncStore.getState();
    expect(state.mirror?.activeContext.activeWorkspaceId).toBe('workspace-10');
    expect(state.mirror?.activeContext.activeTerminalTabId).toBe('terminal-10');
    expect(state.mirror?.activeContext.activeEmbeddedTerminalId).toBe('embedded-10');
    expect(state.mirror?.activeContext.activeSessionId).toBe('session-10');
    expect(state.mirror?.activeContext.projectPath).toBe('/tmp/repo-10');

    const lastSequence = state.lastSequence;
    useSyncStore.getState().appendEvent({
      version: 1,
      sequence: 7,
      eventType: 'provider_session.state_summary',
      generatedAt: '2026-02-09T00:00:02.000Z',
      payload: {
        activeWorkspaceId: 'workspace-ignored',
      },
    });
    expect(useSyncStore.getState().lastSequence).toBe(lastSequence);
  });
});
