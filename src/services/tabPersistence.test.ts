import { beforeEach, describe, expect, it } from 'vitest';
import {
  sanitizeTerminalForHydration,
  type PaneNode,
  type ProjectWorkspaceTab,
  type TerminalTab,
} from '@/contexts/TabContext';
import { TabPersistenceService, validateWorkspaceGraph } from '@/services/tabPersistence';

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

function makeWorkspace(
  id: string,
  order: number,
  terminalTabs: TerminalTab[],
  overrides: Partial<ProjectWorkspaceTab> = {}
): ProjectWorkspaceTab {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id,
    type: 'project',
    projectPath: `/tmp/${id}`,
    title: id,
    activeTerminalTabId: terminalTabs[0]?.id ?? null,
    terminalTabs,
    status: 'idle',
    hasUnsavedChanges: false,
    order,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TabPersistenceService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists workspace array order as canonical ordering', () => {
    const workspaceA = makeWorkspace('workspace-a', 99, [makeTerminal('terminal-a')]);
    const workspaceB = makeWorkspace('workspace-b', 0, [makeTerminal('terminal-b')]);

    TabPersistenceService.saveWorkspace([workspaceA, workspaceB], workspaceB.id);

    const storedRaw = localStorage.getItem('opcode_workspace_v3');
    expect(storedRaw).toBeTruthy();
    const stored = JSON.parse(storedRaw as string) as { tabs: Array<{ id: string }>; activeTabId: string | null };
    expect(stored.tabs.map((tab) => tab.id)).toEqual(['workspace-a', 'workspace-b']);
    expect(stored.activeTabId).toBe('workspace-b');

    const restored = TabPersistenceService.loadWorkspace();
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['workspace-a', 'workspace-b']);
    expect(restored.tabs.map((tab) => tab.order)).toEqual([0, 1]);
    expect(restored.activeTabId).toBe('workspace-b');
  });

  it('falls back to empty workspace and clears storage for invalid graphs', () => {
    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const invalidPayload = {
      version: 3,
      activeTabId: 'workspace-1',
      tabs: [
        {
          id: 'workspace-1',
          type: 'project',
          projectPath: '/tmp/workspace-1',
          title: 'Workspace 1',
          activeTerminalTabId: null,
          terminalTabs: [],
          status: 'idle',
          hasUnsavedChanges: false,
          order: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    localStorage.setItem('opcode_workspace_v3', JSON.stringify(invalidPayload));

    const restored = TabPersistenceService.loadWorkspace();
    expect(restored.tabs).toEqual([]);
    expect(restored.activeTabId).toBeNull();
    expect(localStorage.getItem('opcode_workspace_v3')).toBeNull();
  });

  it('migrates legacy v2 tabs into valid workspace tabs and ignores utility tabs', () => {
    const legacyTabs = [
      { id: 'legacy-settings', type: 'settings', title: 'Settings', order: 0 },
      {
        id: 'legacy-project',
        type: 'projects',
        title: 'Legacy Project',
        projectPath: '/tmp/legacy-project',
        providerId: 'claude',
        order: 1,
      },
      {
        id: 'legacy-chat',
        type: 'chat',
        title: 'Legacy Chat',
        projectPath: '/tmp/legacy-chat',
        providerId: 'claude',
        order: 2,
      },
    ];

    localStorage.setItem('opcode_tabs_v2', JSON.stringify(legacyTabs));
    localStorage.setItem('opcode_active_tab_v2', 'legacy-chat');

    const restored = TabPersistenceService.loadWorkspace();
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['legacy-project', 'legacy-chat']);
    expect(restored.tabs.every((tab) => tab.type === 'project')).toBe(true);
    expect(restored.tabs.every((tab) => tab.terminalTabs.length > 0)).toBe(true);
    expect(restored.activeTabId).toBe('legacy-chat');

    const validation = validateWorkspaceGraph(restored.tabs, restored.activeTabId);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('clears stale embedded terminal ids during hydration while preserving pane restore metadata', () => {
    const paneId = 'terminal-1-pane-1';
    const terminal = makeTerminal('terminal-1', {
      paneStates: {
        [paneId]: {
          embeddedTerminalId: 'embedded-stale-1',
          sessionId: 'session-123',
          restorePreference: 'resume_latest',
          projectPath: '/tmp/project',
        },
      },
    });

    const sanitized = sanitizeTerminalForHydration(terminal);
    expect(sanitized.paneStates[paneId]?.embeddedTerminalId).toBeUndefined();
    expect(sanitized.paneStates[paneId]?.sessionId).toBe('session-123');
    expect(sanitized.paneStates[paneId]?.restorePreference).toBe('resume_latest');
    expect(sanitized.paneStates[paneId]?.projectPath).toBe('/tmp/project');
  });

  it('applies one-time runtime migration to clear embedded terminal ids from stored workspace data', () => {
    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const paneId = 'terminal-1-pane-1';
    const payload = {
      version: 3,
      activeTabId: 'workspace-1',
      tabs: [
        {
          id: 'workspace-1',
          type: 'project',
          projectPath: '/tmp/project',
          title: 'workspace-1',
          activeTerminalTabId: 'terminal-1',
          terminalTabs: [
            {
              id: 'terminal-1',
              kind: 'chat',
              title: 'Terminal 1',
              paneTree: makeLeafPane(paneId),
              activePaneId: paneId,
              paneStates: {
                [paneId]: {
                  embeddedTerminalId: 'embedded-stale-1',
                  sessionId: 'session-123',
                  restorePreference: 'resume_latest',
                  projectPath: '/tmp/project',
                },
              },
              status: 'idle',
              hasUnsavedChanges: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
          status: 'idle',
          hasUnsavedChanges: false,
          order: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    localStorage.setItem('opcode_workspace_v3', JSON.stringify(payload));

    const restored = TabPersistenceService.loadWorkspace();
    const paneState = restored.tabs[0].terminalTabs[0].paneStates[paneId];

    expect(paneState?.embeddedTerminalId).toBeUndefined();
    expect(paneState?.sessionId).toBe('session-123');
    expect(paneState?.restorePreference).toBe('resume_latest');
    expect(paneState?.projectPath).toBe('/tmp/project');

    const storedAfterMigration = JSON.parse(localStorage.getItem('opcode_workspace_v3') as string) as {
      tabs: Array<{ terminalTabs: Array<{ paneStates: Record<string, Record<string, unknown>> }> }>;
    };
    expect(storedAfterMigration.tabs[0].terminalTabs[0].paneStates[paneId]?.embeddedTerminalId).toBeUndefined();
    expect(storedAfterMigration.tabs[0].terminalTabs[0].paneStates[paneId]?.sessionId).toBe(
      'session-123'
    );
  });

  it('persists terminal title lock state and defaults missing values to false', () => {
    const workspace = makeWorkspace('workspace-a', 0, [
      makeTerminal('terminal-locked', { titleLocked: true }),
      makeTerminal('terminal-unlocked', { titleLocked: false }),
    ]);

    TabPersistenceService.saveWorkspace([workspace], workspace.id);
    const restored = TabPersistenceService.loadWorkspace();
    const restoredWorkspace = restored.tabs[0];

    expect(restoredWorkspace.terminalTabs[0].titleLocked).toBe(true);
    expect(restoredWorkspace.terminalTabs[1].titleLocked).toBe(false);

    const raw = localStorage.getItem('opcode_workspace_v3');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      tabs: Array<{ terminalTabs: Array<{ id: string; titleLocked?: boolean }> }>;
    };
    delete parsed.tabs[0].terminalTabs[0].titleLocked;
    localStorage.setItem('opcode_workspace_v3', JSON.stringify(parsed));

    const restoredWithMissingField = TabPersistenceService.loadWorkspace();
    expect(restoredWithMissingField.tabs[0].terminalTabs[0].titleLocked).toBe(false);
  });

  it('round-trips attention status for terminals and workspaces', () => {
    const workspace = makeWorkspace(
      'workspace-attention',
      0,
      [makeTerminal('terminal-attention', { status: 'attention' })],
      { status: 'attention' }
    );

    TabPersistenceService.saveWorkspace([workspace], workspace.id);
    const restored = TabPersistenceService.loadWorkspace();

    expect(restored.tabs[0].status).toBe('attention');
    expect(restored.tabs[0].terminalTabs[0].status).toBe('attention');
  });
});
