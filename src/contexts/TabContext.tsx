import React, {
  createContext,
  useState,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { TabPersistenceService } from '@/services/tabPersistence';
import { SessionPersistenceService } from '@/services/sessionPersistence';

export type UtilityOverlayType =
  | 'agents'
  | 'usage'
  | 'mcp'
  | 'settings'
  | 'claude-md'
  | 'claude-file'
  | null;

export type WorkspaceStatus = 'active' | 'idle' | 'running' | 'complete' | 'error';

export interface PaneLeafNode {
  id: string;
  type: 'leaf';
  leafSessionId: string;
}

export interface PaneSplitNode {
  id: string;
  type: 'split';
  direction: 'vertical';
  left: PaneNode;
  right: PaneNode;
  widthRatio: number;
}

export type PaneNode = PaneLeafNode | PaneSplitNode;

export interface TerminalSessionState {
  sessionId?: string;
  sessionData?: any;
  initialProjectPath?: string;
  providerId?: string;
  agentData?: any;
  agentRunId?: string;
  projectPath?: string;
}

export interface PaneRuntimeState {
  providerId?: string;
  sessionId?: string;
  sessionData?: any;
  projectPath?: string;
  previewUrl?: string;
  isStreaming?: boolean;
  error?: string | null;
}

export interface TerminalTab {
  id: string;
  kind: 'chat' | 'agent';
  title: string;
  providerId?: string;
  sessionState?: TerminalSessionState;
  paneTree: PaneNode;
  activePaneId: string;
  paneStates: Record<string, PaneRuntimeState>;
  status: WorkspaceStatus;
  hasUnsavedChanges: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectWorkspaceTab {
  id: string;
  type: 'project';
  projectPath: string;
  title: string;
  activeTerminalTabId: string | null;
  terminalTabs: TerminalTab[];
  status: WorkspaceStatus;
  hasUnsavedChanges: boolean;
  order: number;
  icon?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type Tab = ProjectWorkspaceTab;

export interface CreateTerminalTabInput {
  kind?: TerminalTab['kind'];
  title?: string;
  providerId?: string;
  sessionState?: TerminalSessionState;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  utilityOverlay: UtilityOverlayType;
  utilityPayload: any;
}

interface TabContextType {
  tabs: Tab[];
  activeTabId: string | null;
  utilityOverlay: UtilityOverlayType;
  utilityPayload: any;
  createProjectWorkspaceTab: (projectPath?: string, title?: string) => string;
  closeProjectWorkspaceTab: (id: string) => void;
  updateProjectWorkspaceTab: (id: string, updates: Partial<Tab>) => void;
  createTerminalTab: (workspaceId: string, input?: CreateTerminalTabInput) => string;
  closeTerminalTab: (workspaceId: string, terminalTabId: string) => void;
  setActiveTerminalTab: (workspaceId: string, terminalTabId: string) => void;
  updateTerminalTab: (workspaceId: string, terminalTabId: string, updates: Partial<TerminalTab>) => void;
  splitPane: (workspaceId: string, terminalTabId: string, paneId: string) => string | null;
  closePane: (workspaceId: string, terminalTabId: string, paneId: string) => void;
  activatePane: (workspaceId: string, terminalTabId: string, paneId: string) => void;
  updatePaneState: (
    workspaceId: string,
    terminalTabId: string,
    paneId: string,
    updates: Partial<PaneRuntimeState>
  ) => void;
  setActiveTab: (id: string) => void;
  reorderTabs: (startIndex: number, endIndex: number) => void;
  getTabById: (id: string) => Tab | undefined;
  openUtilityOverlay: (overlay: Exclude<UtilityOverlayType, null>, payload?: any) => void;
  closeUtilityOverlay: () => void;
  closeAllTabs: () => void;
}

const TabContext = createContext<TabContextType | undefined>(undefined);

const MAX_WORKSPACES = 20;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function basename(path: string): string {
  if (!path) return 'Project';
  const normalized = path.replace(/\\+/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'Project';
}

function collectLeafIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return [node.id];
  }
  return [...collectLeafIds(node.left), ...collectLeafIds(node.right)];
}

function createLeafNode(id?: string): PaneLeafNode {
  const leafId = id || createId('pane');
  return {
    id: leafId,
    type: 'leaf',
    leafSessionId: leafId,
  };
}

function createTerminalTab(projectPath: string, input?: CreateTerminalTabInput): TerminalTab {
  const now = new Date();
  const leaf = createLeafNode();
  const kind = input?.kind || 'chat';
  const providerId = input?.providerId || input?.sessionState?.providerId || 'claude';
  return {
    id: createId('terminal'),
    kind,
    title: input?.title || (kind === 'agent' ? 'Agent Run' : 'Terminal'),
    providerId,
    sessionState: {
      providerId,
      initialProjectPath: projectPath || input?.sessionState?.initialProjectPath,
      projectPath: projectPath || input?.sessionState?.projectPath,
      ...input?.sessionState,
    },
    paneTree: leaf,
    activePaneId: leaf.id,
    paneStates: {},
    status: 'idle',
    hasUnsavedChanges: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createWorkspace(projectPath = '', title?: string, order = 0): Tab {
  const now = new Date();
  const terminal = createTerminalTab(projectPath, {
    kind: 'chat',
    title: 'Terminal 1',
    sessionState: {
      initialProjectPath: projectPath || undefined,
      projectPath: projectPath || undefined,
    },
  });

  return {
    id: createId('workspace'),
    type: 'project',
    projectPath,
    title: title || basename(projectPath),
    activeTerminalTabId: terminal.id,
    terminalTabs: [terminal],
    status: 'idle',
    hasUnsavedChanges: false,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

function mapWorkspaceTabs(
  tabs: Tab[],
  workspaceId: string,
  updater: (workspace: Tab) => Tab
): Tab[] {
  return tabs.map((workspace) => (workspace.id === workspaceId ? updater(workspace) : workspace));
}

function mapTerminalTabs(
  workspace: Tab,
  terminalId: string,
  updater: (terminal: TerminalTab) => TerminalTab
): Tab {
  const nextTerminalTabs = workspace.terminalTabs.map((terminal) =>
    terminal.id === terminalId ? updater(terminal) : terminal
  );
  return {
    ...workspace,
    terminalTabs: nextTerminalTabs,
    updatedAt: new Date(),
  };
}

function splitPaneNode(
  node: PaneNode,
  paneId: string,
  newPaneId: string
): { node: PaneNode; found: boolean } {
  if (node.type === 'leaf') {
    if (node.id !== paneId) {
      return { node, found: false };
    }

    const leftLeaf: PaneLeafNode = {
      id: node.id,
      type: 'leaf',
      leafSessionId: node.leafSessionId,
    };

    const rightLeaf = createLeafNode(newPaneId);

    return {
      found: true,
      node: {
        id: createId('split'),
        type: 'split',
        direction: 'vertical',
        left: leftLeaf,
        right: rightLeaf,
        widthRatio: 50,
      },
    };
  }

  const leftResult = splitPaneNode(node.left, paneId, newPaneId);
  if (leftResult.found) {
    return {
      found: true,
      node: {
        ...node,
        left: leftResult.node,
      },
    };
  }

  const rightResult = splitPaneNode(node.right, paneId, newPaneId);
  if (rightResult.found) {
    return {
      found: true,
      node: {
        ...node,
        right: rightResult.node,
      },
    };
  }

  return { node, found: false };
}

function closePaneNode(node: PaneNode, paneId: string): { node: PaneNode | null; removed: boolean } {
  if (node.type === 'leaf') {
    if (node.id === paneId) {
      return { node: null, removed: true };
    }
    return { node, removed: false };
  }

  const leftResult = closePaneNode(node.left, paneId);
  if (leftResult.removed) {
    if (leftResult.node === null) {
      return { node: node.right, removed: true };
    }
    return {
      removed: true,
      node: {
        ...node,
        left: leftResult.node,
      },
    };
  }

  const rightResult = closePaneNode(node.right, paneId);
  if (rightResult.removed) {
    if (rightResult.node === null) {
      return { node: node.left, removed: true };
    }
    return {
      removed: true,
      node: {
        ...node,
        right: rightResult.node,
      },
    };
  }

  return { node, removed: false };
}

function ensureTerminalHasValidActivePane(terminal: TerminalTab): TerminalTab {
  const leafIds = collectLeafIds(terminal.paneTree);
  if (leafIds.includes(terminal.activePaneId)) {
    return terminal;
  }

  return {
    ...terminal,
    activePaneId: leafIds[0],
  };
}

type Action =
  | { type: 'hydrate'; tabs: Tab[]; activeTabId: string | null }
  | { type: 'set-active-workspace'; id: string }
  | { type: 'create-workspace'; workspace: Tab }
  | { type: 'close-workspace'; id: string }
  | { type: 'update-workspace'; id: string; updates: Partial<Tab> }
  | { type: 'reorder-workspaces'; startIndex: number; endIndex: number }
  | { type: 'replace-workspaces'; tabs: Tab[]; activeTabId: string | null }
  | {
      type: 'replace-terminal';
      workspaceId: string;
      terminalId: string;
      updater: (terminal: TerminalTab) => TerminalTab;
    }
  | { type: 'open-utility'; overlay: Exclude<UtilityOverlayType, null>; payload?: any }
  | { type: 'close-utility' };

const initialState: WorkspaceState = {
  tabs: [],
  activeTabId: null,
  utilityOverlay: null,
  utilityPayload: null,
};

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case 'hydrate':
      return {
        ...state,
        tabs: action.tabs,
        activeTabId: action.activeTabId,
      };

    case 'set-active-workspace':
      if (!state.tabs.some((tab) => tab.id === action.id)) {
        return state;
      }
      return {
        ...state,
        activeTabId: action.id,
      };

    case 'create-workspace': {
      const tabs = [...state.tabs, action.workspace].map((tab, index) => ({ ...tab, order: index }));
      return {
        ...state,
        tabs,
        activeTabId: action.workspace.id,
      };
    }

    case 'close-workspace': {
      const removedIndex = state.tabs.findIndex((tab) => tab.id === action.id);
      if (removedIndex === -1) {
        return state;
      }

      const tabs = state.tabs
        .filter((tab) => tab.id !== action.id)
        .map((tab, index) => ({ ...tab, order: index }));

      let activeTabId = state.activeTabId;
      if (state.activeTabId === action.id) {
        activeTabId = tabs[Math.max(0, removedIndex - 1)]?.id || tabs[0]?.id || null;
      }

      return {
        ...state,
        tabs,
        activeTabId,
      };
    }

    case 'update-workspace': {
      const tabs = state.tabs.map((tab) =>
        tab.id === action.id
          ? {
              ...tab,
              ...action.updates,
              updatedAt: new Date(),
            }
          : tab
      );
      return {
        ...state,
        tabs,
      };
    }

    case 'reorder-workspaces': {
      if (
        action.startIndex < 0 ||
        action.endIndex < 0 ||
        action.startIndex >= state.tabs.length ||
        action.endIndex >= state.tabs.length
      ) {
        return state;
      }

      const next = [...state.tabs];
      const [moved] = next.splice(action.startIndex, 1);
      next.splice(action.endIndex, 0, moved);

      return {
        ...state,
        tabs: next.map((tab, index) => ({ ...tab, order: index })),
      };
    }

    case 'replace-workspaces':
      return {
        ...state,
        tabs: action.tabs,
        activeTabId: action.activeTabId,
      };

    case 'replace-terminal': {
      const tabs = mapWorkspaceTabs(state.tabs, action.workspaceId, (workspace) =>
        mapTerminalTabs(workspace, action.terminalId, (terminal) =>
          ensureTerminalHasValidActivePane(action.updater(terminal))
        )
      );

      return {
        ...state,
        tabs,
      };
    }

    case 'open-utility':
      return {
        ...state,
        utilityOverlay: action.overlay,
        utilityPayload: action.payload ?? null,
      };

    case 'close-utility':
      return {
        ...state,
        utilityOverlay: null,
        utilityPayload: null,
      };

    default:
      return state;
  }
}

export const TabProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isInitialized, setIsInitialized] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout>();
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const loadWorkspace = async () => {
      const { tabs: savedTabs, activeTabId } = TabPersistenceService.loadWorkspace();

      const restoredTabs = savedTabs.map((workspace) => ({
        ...workspace,
        terminalTabs: workspace.terminalTabs.map((terminal) => {
          if (terminal.kind !== 'chat' || !terminal.sessionState?.sessionId) {
            return terminal;
          }

          const sessionData = SessionPersistenceService.loadSession(terminal.sessionState.sessionId);
          if (!sessionData) {
            return terminal;
          }

          const restoredSession = SessionPersistenceService.createSessionFromRestoreData(sessionData);
          return {
            ...terminal,
            sessionState: {
              ...terminal.sessionState,
              sessionData: restoredSession,
              initialProjectPath: terminal.sessionState.initialProjectPath || sessionData.projectPath,
              projectPath: terminal.sessionState.projectPath || sessionData.projectPath,
            },
          };
        }),
      }));

      dispatch({ type: 'hydrate', tabs: restoredTabs, activeTabId });
      setIsInitialized(true);
    };

    loadWorkspace();
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      TabPersistenceService.saveWorkspace(state.tabs, state.activeTabId);
    }, 400);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [state.tabs, state.activeTabId, isInitialized]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!isInitialized) return;
      TabPersistenceService.saveWorkspace(stateRef.current.tabs, stateRef.current.activeTabId);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (isInitialized) {
        TabPersistenceService.saveWorkspace(stateRef.current.tabs, stateRef.current.activeTabId);
      }
    };
  }, [isInitialized]);

  const createProjectWorkspaceTab = useCallback((projectPath = '', title?: string): string => {
    if (stateRef.current.tabs.length >= MAX_WORKSPACES) {
      throw new Error(`Maximum number of project tabs (${MAX_WORKSPACES}) reached`);
    }

    const workspace = createWorkspace(projectPath, title, stateRef.current.tabs.length);
    const nextTabs = [...stateRef.current.tabs, workspace].map((tab, index) => ({ ...tab, order: index }));
    stateRef.current = {
      ...stateRef.current,
      tabs: nextTabs,
      activeTabId: workspace.id,
    };
    dispatch({ type: 'create-workspace', workspace });
    return workspace.id;
  }, []);

  const closeProjectWorkspaceTab = useCallback((id: string) => {
    dispatch({ type: 'close-workspace', id });
  }, []);

  const updateProjectWorkspaceTab = useCallback((id: string, updates: Partial<Tab>) => {
    dispatch({ type: 'update-workspace', id, updates });
  }, []);

  const setActiveTab = useCallback((id: string) => {
    dispatch({ type: 'set-active-workspace', id });
  }, []);

  const reorderTabs = useCallback((startIndex: number, endIndex: number) => {
    dispatch({ type: 'reorder-workspaces', startIndex, endIndex });
  }, []);

  const createTerminalTabForWorkspace = useCallback((workspaceId: string, input?: CreateTerminalTabInput): string => {
    const workspace = stateRef.current.tabs.find((tab) => tab.id === workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const terminal = createTerminalTab(workspace.projectPath, input);
    const nextWorkspace: Tab = {
      ...workspace,
      terminalTabs: [...workspace.terminalTabs, terminal],
      activeTerminalTabId: terminal.id,
      updatedAt: new Date(),
      status: 'active',
    };

    const tabs = stateRef.current.tabs.map((tab) => (tab.id === workspaceId ? nextWorkspace : tab));
    dispatch({ type: 'replace-workspaces', tabs, activeTabId: workspaceId });
    return terminal.id;
  }, []);

  const closeTerminalTab = useCallback((workspaceId: string, terminalTabId: string) => {
    const workspace = stateRef.current.tabs.find((tab) => tab.id === workspaceId);
    if (!workspace) return;

    const filtered = workspace.terminalTabs.filter((terminal) => terminal.id !== terminalTabId);

    const nextTerminalTabs = filtered.length > 0
      ? filtered
      : [
          createTerminalTab(workspace.projectPath, {
            kind: 'chat',
            title: 'Terminal 1',
            sessionState: {
              initialProjectPath: workspace.projectPath || undefined,
              projectPath: workspace.projectPath || undefined,
            },
          }),
        ];

    const activeTerminalTabId = nextTerminalTabs.some((terminal) => terminal.id === workspace.activeTerminalTabId)
      ? workspace.activeTerminalTabId
      : nextTerminalTabs[0].id;

    const tabs = stateRef.current.tabs.map((tab) =>
      tab.id === workspaceId
        ? {
            ...tab,
            terminalTabs: nextTerminalTabs,
            activeTerminalTabId,
            updatedAt: new Date(),
          }
        : tab
    );

    dispatch({ type: 'replace-workspaces', tabs, activeTabId: stateRef.current.activeTabId });
  }, []);

  const setActiveTerminalTab = useCallback((workspaceId: string, terminalTabId: string) => {
    const tabs = mapWorkspaceTabs(stateRef.current.tabs, workspaceId, (workspace) => {
      if (!workspace.terminalTabs.some((terminal) => terminal.id === terminalTabId)) {
        return workspace;
      }
      return {
        ...workspace,
        activeTerminalTabId: terminalTabId,
        updatedAt: new Date(),
      };
    });

    dispatch({
      type: 'replace-workspaces',
      tabs,
      activeTabId: stateRef.current.activeTabId,
    });
  }, []);

  const updateTerminalTab = useCallback(
    (workspaceId: string, terminalTabId: string, updates: Partial<TerminalTab>) => {
      dispatch({
        type: 'replace-terminal',
        workspaceId,
        terminalId: terminalTabId,
        updater: (terminal) => ({
          ...terminal,
          ...updates,
          updatedAt: new Date(),
        }),
      });
    },
    []
  );

  const splitPane = useCallback((workspaceId: string, terminalTabId: string, paneId: string): string | null => {
    const workspace = stateRef.current.tabs.find((tab) => tab.id === workspaceId);
    const terminal = workspace?.terminalTabs.find((entry) => entry.id === terminalTabId);
    if (!workspace || !terminal) return null;

    const newPaneId = createId('pane');
    const splitResult = splitPaneNode(terminal.paneTree, paneId, newPaneId);
    if (!splitResult.found) {
      return null;
    }

    dispatch({
      type: 'replace-terminal',
      workspaceId,
      terminalId: terminalTabId,
      updater: (current) => ({
        ...current,
        paneTree: splitResult.node,
        activePaneId: newPaneId,
        paneStates: {
          ...current.paneStates,
          [newPaneId]: {
            providerId: current.providerId,
            projectPath: current.sessionState?.projectPath || current.sessionState?.initialProjectPath,
          },
        },
        updatedAt: new Date(),
      }),
    });

    return newPaneId;
  }, []);

  const closePane = useCallback((workspaceId: string, terminalTabId: string, paneId: string) => {
    const workspace = stateRef.current.tabs.find((tab) => tab.id === workspaceId);
    const terminal = workspace?.terminalTabs.find((entry) => entry.id === terminalTabId);
    if (!workspace || !terminal) return;

    const leafIds = collectLeafIds(terminal.paneTree);
    if (leafIds.length <= 1) {
      return;
    }

    const result = closePaneNode(terminal.paneTree, paneId);
    if (!result.removed || !result.node) {
      return;
    }

    const nextLeafIds = collectLeafIds(result.node);
    const nextActivePaneId = nextLeafIds.includes(terminal.activePaneId)
      ? terminal.activePaneId
      : nextLeafIds[0];

    dispatch({
      type: 'replace-terminal',
      workspaceId,
      terminalId: terminalTabId,
      updater: (current) => {
        const nextPaneStates = { ...current.paneStates };
        delete nextPaneStates[paneId];

        return {
          ...current,
          paneTree: result.node as PaneNode,
          activePaneId: nextActivePaneId,
          paneStates: nextPaneStates,
          updatedAt: new Date(),
        };
      },
    });
  }, []);

  const activatePane = useCallback((workspaceId: string, terminalTabId: string, paneId: string) => {
    dispatch({
      type: 'replace-terminal',
      workspaceId,
      terminalId: terminalTabId,
      updater: (terminal) => {
        const leafIds = collectLeafIds(terminal.paneTree);
        if (!leafIds.includes(paneId)) {
          return terminal;
        }
        return {
          ...terminal,
          activePaneId: paneId,
          updatedAt: new Date(),
        };
      },
    });
  }, []);

  const updatePaneState = useCallback(
    (
      workspaceId: string,
      terminalTabId: string,
      paneId: string,
      updates: Partial<PaneRuntimeState>
    ) => {
      dispatch({
        type: 'replace-terminal',
        workspaceId,
        terminalId: terminalTabId,
        updater: (terminal) => ({
          ...terminal,
          paneStates: {
            ...terminal.paneStates,
            [paneId]: {
              ...terminal.paneStates[paneId],
              ...updates,
            },
          },
          updatedAt: new Date(),
        }),
      });
    },
    []
  );

  const openUtilityOverlay = useCallback((overlay: Exclude<UtilityOverlayType, null>, payload?: any) => {
    dispatch({ type: 'open-utility', overlay, payload });
  }, []);

  const closeUtilityOverlay = useCallback(() => {
    dispatch({ type: 'close-utility' });
  }, []);

  const getTabById = useCallback((id: string): Tab | undefined => {
    return state.tabs.find((tab) => tab.id === id);
  }, [state.tabs]);

  const closeAllTabs = useCallback(() => {
    dispatch({ type: 'replace-workspaces', tabs: [], activeTabId: null });
    TabPersistenceService.clearWorkspace();
  }, []);

  const value = useMemo<TabContextType>(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      utilityOverlay: state.utilityOverlay,
      utilityPayload: state.utilityPayload,
      createProjectWorkspaceTab,
      closeProjectWorkspaceTab,
      updateProjectWorkspaceTab,
      createTerminalTab: createTerminalTabForWorkspace,
      closeTerminalTab,
      setActiveTerminalTab,
      updateTerminalTab,
      splitPane,
      closePane,
      activatePane,
      updatePaneState,
      setActiveTab,
      reorderTabs,
      getTabById,
      openUtilityOverlay,
      closeUtilityOverlay,
      closeAllTabs,
    }),
    [
      state,
      createProjectWorkspaceTab,
      closeProjectWorkspaceTab,
      updateProjectWorkspaceTab,
      createTerminalTabForWorkspace,
      closeTerminalTab,
      setActiveTerminalTab,
      updateTerminalTab,
      splitPane,
      closePane,
      activatePane,
      updatePaneState,
      setActiveTab,
      reorderTabs,
      getTabById,
      openUtilityOverlay,
      closeUtilityOverlay,
      closeAllTabs,
    ]
  );

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
};

export const useTabContext = () => {
  const context = useContext(TabContext);
  if (!context) {
    throw new Error('useTabContext must be used within a TabProvider');
  }
  return context;
};
