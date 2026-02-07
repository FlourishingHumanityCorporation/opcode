import { describe, expect, it } from 'vitest';
import type { PaneNode, Tab, TerminalTab } from '@/contexts/TabContext';
import { tabReducer } from '@/contexts/TabContext';

type WorkspaceState = Parameters<typeof tabReducer>[0];
type WorkspaceAction = Parameters<typeof tabReducer>[1];

function makeLeafPane(id: string): PaneNode {
  return {
    id,
    type: 'leaf',
    leafSessionId: id,
  };
}

function makeTerminal(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  const paneId = `${id}-pane-1`;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id,
    kind: 'chat',
    title: `Terminal ${id}`,
    providerId: 'claude',
    sessionState: {
      providerId: 'claude',
      projectPath: '/tmp/project',
      initialProjectPath: '/tmp/project',
    },
    paneTree: makeLeafPane(paneId),
    activePaneId: paneId,
    paneStates: {},
    status: 'idle',
    hasUnsavedChanges: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeWorkspace(id: string, order: number, terminals: TerminalTab[]): Tab {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id,
    type: 'project',
    projectPath: `/tmp/${id}`,
    title: id,
    activeTerminalTabId: terminals[0]?.id ?? null,
    terminalTabs: terminals,
    status: 'idle',
    hasUnsavedChanges: false,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

function makeState(tabs: Tab[], activeTabId: string | null): WorkspaceState {
  return {
    tabs,
    activeTabId,
    utilityOverlay: null,
    utilityPayload: null,
  };
}

function reduce(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  return tabReducer(state, action);
}

describe('tabReducer', () => {
  it('reorders workspaces deterministically by ordered IDs', () => {
    const state = makeState(
      [
        makeWorkspace('workspace-a', 0, [makeTerminal('terminal-a')]),
        makeWorkspace('workspace-b', 1, [makeTerminal('terminal-b')]),
        makeWorkspace('workspace-c', 2, [makeTerminal('terminal-c')]),
      ],
      'workspace-b'
    );

    const next = reduce(state, {
      type: 'set-workspace-order-by-ids',
      orderedIds: ['workspace-c', 'workspace-a', 'workspace-b'],
    });

    expect(next.tabs.map((tab) => tab.id)).toEqual(['workspace-c', 'workspace-a', 'workspace-b']);
    expect(next.tabs.map((tab) => tab.order)).toEqual([0, 1, 2]);
    expect(next.activeTabId).toBe('workspace-b');
  });

  it('falls back active workspace when active tab is missing from ordered IDs', () => {
    const state = makeState(
      [
        makeWorkspace('workspace-a', 0, [makeTerminal('terminal-a')]),
        makeWorkspace('workspace-b', 1, [makeTerminal('terminal-b')]),
        makeWorkspace('workspace-c', 2, [makeTerminal('terminal-c')]),
      ],
      'workspace-a'
    );

    const next = reduce(state, {
      type: 'set-workspace-order-by-ids',
      orderedIds: ['workspace-c', 'workspace-b'],
    });

    expect(next.tabs.map((tab) => tab.id)).toEqual(['workspace-c', 'workspace-b', 'workspace-a']);
    expect(next.activeTabId).toBe('workspace-a');
  });

  it('maintains terminal invariants across create/set-active/close operations', () => {
    const initial = makeState(
      [makeWorkspace('workspace-a', 0, [makeTerminal('terminal-1')])],
      'workspace-a'
    );

    const withCreated = reduce(initial, {
      type: 'create-terminal',
      workspaceId: 'workspace-a',
      terminal: makeTerminal('terminal-2'),
    });
    const afterCreate = withCreated.tabs[0];
    expect(afterCreate.terminalTabs.map((terminal) => terminal.id)).toEqual(['terminal-1', 'terminal-2']);
    expect(afterCreate.activeTerminalTabId).toBe('terminal-2');
    expect(afterCreate.status).toBe('active');

    const withActiveFirst = reduce(withCreated, {
      type: 'set-active-terminal',
      workspaceId: 'workspace-a',
      terminalTabId: 'terminal-1',
    });
    expect(withActiveFirst.tabs[0].activeTerminalTabId).toBe('terminal-1');

    const afterCloseFirst = reduce(withActiveFirst, {
      type: 'close-terminal',
      workspaceId: 'workspace-a',
      terminalTabId: 'terminal-1',
    });
    expect(afterCloseFirst.tabs[0].terminalTabs.map((terminal) => terminal.id)).toEqual(['terminal-2']);
    expect(afterCloseFirst.tabs[0].activeTerminalTabId).toBe('terminal-2');

    const afterCloseLast = reduce(afterCloseFirst, {
      type: 'close-terminal',
      workspaceId: 'workspace-a',
      terminalTabId: 'terminal-2',
    });
    const workspaceAfterLastClose = afterCloseLast.tabs[0];
    expect(workspaceAfterLastClose.terminalTabs).toHaveLength(1);
    expect(workspaceAfterLastClose.activeTerminalTabId).toBe(workspaceAfterLastClose.terminalTabs[0].id);
    expect(workspaceAfterLastClose.terminalTabs[0].activePaneId).toBeTruthy();
  });
});
