import { useCallback, useMemo } from 'react';
import {
  type CreateTerminalTabInput,
  type PaneRuntimeState,
  type Tab,
  type TerminalTab,
  useTabContext,
} from '@/contexts/TabContext';
import {
  projectNameFromPath,
  shouldAutoRenameWorkspaceTitle,
} from '@/lib/terminalPaneState';

export type LegacyTabType =
  | 'project'
  | 'projects'
  | 'chat'
  | 'agent'
  | 'agents'
  | 'usage'
  | 'mcp'
  | 'settings'
  | 'claude-md'
  | 'claude-file'
  | 'agent-execution'
  | 'create-agent'
  | 'import-agent';

interface TerminalLocation {
  workspace: Tab;
  terminal: TerminalTab;
}

interface UseTabStateReturn {
  // State
  tabs: Tab[];
  activeTab: Tab | undefined;
  activeWorkspace: Tab | undefined;
  activeTabId: string | null;
  isInitialized: boolean;
  utilityOverlay: ReturnType<typeof useTabContext>['utilityOverlay'];
  utilityPayload: ReturnType<typeof useTabContext>['utilityPayload'];
  tabCount: number;
  chatTabCount: number;
  agentTabCount: number;

  // New workspace operations
  createProjectWorkspaceTab: (projectPath?: string, title?: string) => string;
  closeProjectWorkspaceTab: (id: string) => void;
  createTerminalTab: (workspaceId?: string, input?: CreateTerminalTabInput) => string;
  closeTerminalTab: (workspaceId: string, terminalTabId: string) => void;
  setActiveTerminalTab: (workspaceId: string, terminalTabId: string) => void;
  setWorkspaceOrderByIds: (orderedWorkspaceIds: string[]) => void;
  splitPane: (workspaceId: string, terminalTabId: string, paneId: string) => string | null;
  closePane: (workspaceId: string, terminalTabId: string, paneId: string) => void;
  activatePane: (workspaceId: string, terminalTabId: string, paneId: string) => void;
  updatePaneState: (
    workspaceId: string,
    terminalTabId: string,
    paneId: string,
    updates: Partial<PaneRuntimeState>
  ) => void;
  runAgentInTerminalTab: (agent: any, projectPath?: string) => string;
  openUtilityOverlay: (
    overlay: 'agents' | 'usage' | 'mcp' | 'settings' | 'claude-md' | 'claude-file' | 'diagnostics',
    payload?: any
  ) => void;
  closeUtilityOverlay: () => void;

  // Compatibility operations
  createChatTab: (projectId?: string, title?: string, projectPath?: string) => string;
  createAgentTab: (agentRunId: string, agentName: string) => string;
  createAgentExecutionTab: (agent: any, tabId: string, projectPath?: string) => string;
  createProjectsTab: () => string | null;
  createAgentsTab: () => string | null;
  createUsageTab: () => string | null;
  createMCPTab: () => string | null;
  createSettingsTab: () => string | null;
  createClaudeMdTab: () => string | null;
  createClaudeFileTab: (fileId: string, fileName: string) => string;
  createCreateAgentTab: () => string;
  createImportAgentTab: () => string;
  closeTab: (id: string, force?: boolean) => Promise<boolean>;
  closeCurrentTab: () => Promise<boolean>;
  switchToTab: (id: string) => void;
  switchToNextTab: () => void;
  switchToPreviousTab: () => void;
  switchToTabByIndex: (index: number) => void;
  updateTab: (id: string, updates: Partial<Tab> | Partial<TerminalTab>) => void;
  updateTabTitle: (id: string, title: string) => void;
  updateTabStatus: (id: string, status: TerminalTab['status']) => void;
  markTabAsChanged: (id: string, hasChanges: boolean) => void;
  findTabBySessionId: (sessionId: string) => (Tab | TerminalTab | undefined);
  findTabByAgentRunId: (agentRunId: string) => (Tab | TerminalTab | undefined);
  findTabByType: (type: LegacyTabType) => (Tab | undefined);
  canAddTab: () => boolean;
}

function isTerminalUpdate(update: Partial<Tab> | Partial<TerminalTab>): update is Partial<TerminalTab> {
  return (
    'paneTree' in update ||
    'paneStates' in update ||
    'kind' in update ||
    'sessionState' in update ||
    'activePaneId' in update
  );
}

export const useTabState = (): UseTabStateReturn => {
  const {
    tabs,
    activeTabId,
    isInitialized,
    utilityOverlay,
    utilityPayload,
    createProjectWorkspaceTab,
    closeProjectWorkspaceTab,
    updateProjectWorkspaceTab,
    createTerminalTab: createTerminalTabInWorkspace,
    closeTerminalTab,
    setActiveTerminalTab,
    updateTerminalTab,
    splitPane,
    closePane,
    activatePane,
    updatePaneState,
    setActiveTab,
    setWorkspaceOrderByIds,
    openUtilityOverlay,
    closeUtilityOverlay,
    getTabById,
  } = useTabContext();

  const activeTab = useMemo(() => (activeTabId ? getTabById(activeTabId) : undefined), [activeTabId, getTabById]);
  const activeWorkspace = activeTab;

  const chatTabCount = useMemo(
    () => tabs.reduce((count, workspace) => count + workspace.terminalTabs.filter((terminal) => terminal.kind === 'chat').length, 0),
    [tabs]
  );

  const agentTabCount = useMemo(
    () => tabs.reduce((count, workspace) => count + workspace.terminalTabs.filter((terminal) => terminal.kind === 'agent').length, 0),
    [tabs]
  );

  const findTerminalLocation = useCallback(
    (id: string): TerminalLocation | undefined => {
      for (const workspace of tabs) {
        const terminal = workspace.terminalTabs.find((entry) => entry.id === id);
        if (terminal) {
          return { workspace, terminal };
        }
      }
      return undefined;
    },
    [tabs]
  );

  const ensureWorkspace = useCallback((): Tab => {
    if (activeWorkspace) {
      return activeWorkspace;
    }

    const workspaceId = createProjectWorkspaceTab('', 'Project');
    const workspace = tabs.find((tab) => tab.id === workspaceId);
    if (!workspace) {
      // fallback for immediate usage after creation
      return {
        id: workspaceId,
        type: 'project',
        projectPath: '',
        title: 'Project',
        activeTerminalTabId: null,
        terminalTabs: [],
        status: 'idle',
        hasUnsavedChanges: false,
        order: tabs.length,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    return workspace;
  }, [activeWorkspace, createProjectWorkspaceTab, tabs]);

  const createTerminalTab = useCallback(
    (workspaceId?: string, input?: CreateTerminalTabInput): string => {
      const targetWorkspaceId = workspaceId || activeWorkspace?.id || ensureWorkspace().id;
      return createTerminalTabInWorkspace(targetWorkspaceId, input);
    },
    [activeWorkspace, createTerminalTabInWorkspace, ensureWorkspace]
  );

  const runAgentInTerminalTab = useCallback(
    (agent: any, projectPath?: string): string => {
      const workspace = activeWorkspace || ensureWorkspace();

      if (!workspace.projectPath && projectPath) {
        const shouldAutoRename = shouldAutoRenameWorkspaceTitle(
          workspace.title,
          workspace.projectPath
        );
        updateProjectWorkspaceTab(workspace.id, {
          projectPath,
          title: shouldAutoRename
            ? projectNameFromPath(projectPath) || workspace.title
            : workspace.title,
        });
      }

      return createTerminalTabInWorkspace(workspace.id, {
        kind: 'agent',
        title: `Run: ${agent?.name || 'Agent'}`,
        providerId: agent?.provider_id,
        sessionState: {
          agentData: agent,
          providerId: agent?.provider_id,
          projectPath: projectPath || workspace.projectPath || undefined,
          initialProjectPath: projectPath || workspace.projectPath || undefined,
        },
      });
    },
    [activeWorkspace, createTerminalTabInWorkspace, ensureWorkspace, updateProjectWorkspaceTab]
  );

  const createChatTab = useCallback(
    (projectId?: string, title?: string, projectPath?: string): string => {
      const workspace = activeWorkspace || ensureWorkspace();
      if (projectPath && workspace.projectPath !== projectPath) {
        const shouldAutoRename = shouldAutoRenameWorkspaceTitle(
          workspace.title,
          workspace.projectPath
        );
        updateProjectWorkspaceTab(workspace.id, {
          projectPath,
          title: shouldAutoRename
            ? projectNameFromPath(projectPath) || workspace.title
            : workspace.title,
        });
      }

      return createTerminalTabInWorkspace(workspace.id, {
        kind: 'chat',
        title: title || `Terminal ${workspace.terminalTabs.length + 1}`,
        sessionState: {
          sessionId: projectId,
          initialProjectPath: projectPath || workspace.projectPath || undefined,
          projectPath: projectPath || workspace.projectPath || undefined,
        },
      });
    },
    [activeWorkspace, createTerminalTabInWorkspace, ensureWorkspace, updateProjectWorkspaceTab]
  );

  const createAgentTab = useCallback(
    (agentRunId: string, agentName: string): string => {
      const existing = tabs
        .flatMap((workspace) => workspace.terminalTabs.map((terminal) => ({ workspace, terminal })))
        .find(({ terminal }) => terminal.kind === 'agent' && terminal.sessionState?.agentRunId === agentRunId);

      if (existing) {
        setActiveTab(existing.workspace.id);
        setActiveTerminalTab(existing.workspace.id, existing.terminal.id);
        return existing.terminal.id;
      }

      const workspace = activeWorkspace || ensureWorkspace();
      return createTerminalTabInWorkspace(workspace.id, {
        kind: 'agent',
        title: agentName,
        sessionState: {
          agentRunId,
          projectPath: workspace.projectPath || undefined,
          initialProjectPath: workspace.projectPath || undefined,
        },
      });
    },
    [activeWorkspace, createTerminalTabInWorkspace, ensureWorkspace, setActiveTab, setActiveTerminalTab, tabs]
  );

  const createAgentExecutionTab = useCallback(
    (agent: any, _tabId: string, projectPath?: string): string => {
      return runAgentInTerminalTab(agent, projectPath);
    },
    [runAgentInTerminalTab]
  );

  const createProjectsTab = useCallback((): string | null => {
    return createProjectWorkspaceTab('', 'Project');
  }, [createProjectWorkspaceTab]);

  const createAgentsTab = useCallback((): string | null => {
    openUtilityOverlay('agents');
    return activeWorkspace?.id ?? null;
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createUsageTab = useCallback((): string | null => {
    openUtilityOverlay('usage');
    return activeWorkspace?.id ?? null;
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createMCPTab = useCallback((): string | null => {
    openUtilityOverlay('mcp');
    return activeWorkspace?.id ?? null;
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createSettingsTab = useCallback((): string | null => {
    openUtilityOverlay('settings');
    return activeWorkspace?.id ?? null;
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createClaudeMdTab = useCallback((): string | null => {
    openUtilityOverlay('claude-md');
    return activeWorkspace?.id ?? null;
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createClaudeFileTab = useCallback((fileId: string, fileName: string): string => {
    openUtilityOverlay('claude-file', { fileId, fileName });
    return activeWorkspace?.id || '';
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createCreateAgentTab = useCallback((): string => {
    openUtilityOverlay('agents', { mode: 'create' });
    return activeWorkspace?.id || '';
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const createImportAgentTab = useCallback((): string => {
    openUtilityOverlay('agents', { mode: 'import' });
    return activeWorkspace?.id || '';
  }, [activeWorkspace?.id, openUtilityOverlay]);

  const closeTab = useCallback(
    async (id: string, force = false): Promise<boolean> => {
      const workspace = tabs.find((tab) => tab.id === id);
      if (workspace) {
        if (!force && workspace.hasUnsavedChanges) {
          const confirmed = window.confirm(`Project "${workspace.title}" has unsaved changes. Close anyway?`);
          if (!confirmed) return false;
        }
        closeProjectWorkspaceTab(id);
        return true;
      }

      const location = findTerminalLocation(id);
      if (location) {
        if (!force && location.terminal.hasUnsavedChanges) {
          const confirmed = window.confirm(`Terminal "${location.terminal.title}" has unsaved changes. Close anyway?`);
          if (!confirmed) return false;
        }
        closeTerminalTab(location.workspace.id, location.terminal.id);
      }

      return true;
    },
    [closeProjectWorkspaceTab, closeTerminalTab, findTerminalLocation, tabs]
  );

  const closeCurrentTab = useCallback(async (): Promise<boolean> => {
    if (!activeTabId) return true;
    return closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const switchToNextTab = useCallback(() => {
    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const nextIndex = (currentIndex + 1) % tabs.length;
    setActiveTab(tabs[nextIndex].id);
  }, [tabs, activeTabId, setActiveTab]);

  const switchToPreviousTab = useCallback(() => {
    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const previousIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
    setActiveTab(tabs[previousIndex].id);
  }, [tabs, activeTabId, setActiveTab]);

  const switchToTabByIndex = useCallback((index: number) => {
    if (index >= 0 && index < tabs.length) {
      setActiveTab(tabs[index].id);
    }
  }, [tabs, setActiveTab]);

  const updateTab = useCallback(
    (id: string, updates: Partial<Tab> | Partial<TerminalTab>) => {
      if (isTerminalUpdate(updates)) {
        const location = findTerminalLocation(id);
        if (location) {
          updateTerminalTab(location.workspace.id, id, updates);
          return;
        }
      }

      const workspace = tabs.find((tab) => tab.id === id);
      if (workspace) {
        updateProjectWorkspaceTab(id, updates as Partial<Tab>);
        return;
      }

      const location = findTerminalLocation(id);
      if (location) {
        updateTerminalTab(location.workspace.id, id, updates as Partial<TerminalTab>);
      }
    },
    [findTerminalLocation, tabs, updateProjectWorkspaceTab, updateTerminalTab]
  );

  const updateTabTitle = useCallback((id: string, title: string) => {
    const workspace = tabs.find((tab) => tab.id === id);
    if (workspace) {
      updateProjectWorkspaceTab(id, { title });
      return;
    }

    const location = findTerminalLocation(id);
    if (location) {
      updateTerminalTab(location.workspace.id, id, { title });
    }
  }, [findTerminalLocation, tabs, updateProjectWorkspaceTab, updateTerminalTab]);

  const updateTabStatus = useCallback(
    (id: string, status: TerminalTab['status']) => {
      const workspace = tabs.find((tab) => tab.id === id);
      if (workspace) {
        updateProjectWorkspaceTab(id, { status });
        return;
      }

      const location = findTerminalLocation(id);
      if (location) {
        updateTerminalTab(location.workspace.id, id, { status });
      }
    },
    [findTerminalLocation, tabs, updateProjectWorkspaceTab, updateTerminalTab]
  );

  const markTabAsChanged = useCallback(
    (id: string, hasChanges: boolean) => {
      const workspace = tabs.find((tab) => tab.id === id);
      if (workspace) {
        updateProjectWorkspaceTab(id, { hasUnsavedChanges: hasChanges });
        return;
      }

      const location = findTerminalLocation(id);
      if (location) {
        updateTerminalTab(location.workspace.id, id, { hasUnsavedChanges: hasChanges });
      }
    },
    [findTerminalLocation, tabs, updateProjectWorkspaceTab, updateTerminalTab]
  );

  const findTabBySessionId = useCallback(
    (sessionId: string): Tab | TerminalTab | undefined => {
      for (const workspace of tabs) {
        const terminal = workspace.terminalTabs.find((entry) => entry.sessionState?.sessionId === sessionId);
        if (terminal) return terminal;
      }
      return undefined;
    },
    [tabs]
  );

  const findTabByAgentRunId = useCallback(
    (agentRunId: string): Tab | TerminalTab | undefined => {
      for (const workspace of tabs) {
        const terminal = workspace.terminalTabs.find((entry) => entry.sessionState?.agentRunId === agentRunId);
        if (terminal) return terminal;
      }
      return undefined;
    },
    [tabs]
  );

  const findTabByType = useCallback(
    (type: LegacyTabType): Tab | undefined => {
      if (type === 'project' || type === 'projects') {
        return tabs[0];
      }
      return undefined;
    },
    [tabs]
  );

  const canAddTab = useCallback((): boolean => tabs.length < 20, [tabs.length]);

  return {
    // State
    tabs,
    activeTab,
    activeWorkspace,
    activeTabId,
    isInitialized,
    utilityOverlay,
    utilityPayload,
    tabCount: tabs.length,
    chatTabCount,
    agentTabCount,

    // New workspace operations
    createProjectWorkspaceTab,
    closeProjectWorkspaceTab,
    createTerminalTab,
    closeTerminalTab,
    setActiveTerminalTab,
    splitPane,
    closePane,
    activatePane,
    updatePaneState,
    setWorkspaceOrderByIds,
    runAgentInTerminalTab,
    openUtilityOverlay,
    closeUtilityOverlay,

    // Compatibility operations
    createChatTab,
    createAgentTab,
    createAgentExecutionTab,
    createProjectsTab,
    createAgentsTab,
    createUsageTab,
    createMCPTab,
    createSettingsTab,
    createClaudeMdTab,
    createClaudeFileTab,
    createCreateAgentTab,
    createImportAgentTab,
    closeTab,
    closeCurrentTab,
    switchToTab: setActiveTab,
    switchToNextTab,
    switchToPreviousTab,
    switchToTabByIndex,
    updateTab,
    updateTabTitle,
    updateTabStatus,
    markTabAsChanged,
    findTabBySessionId,
    findTabByAgentRunId,
    findTabByType,
    canAddTab,
  };
};
