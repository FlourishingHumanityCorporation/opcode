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
import { hashWorkspaceState, logWorkspaceEvent } from '@/services/workspaceDiagnostics';
import { setTerminalWorkspaceSnapshotProvider } from '@/services/terminalHangDiagnostics';
import {
  buildProviderSessionStateSummaryPayload,
  buildTerminalStateSummaryPayload,
  buildWorkspaceStateChangedPayload,
  mobileSyncBridge,
} from '@/services/mobileSyncBridge';
import { api } from '@/lib/api';

export type UtilityOverlayType =
  | 'agents'
  | 'usage'
  | 'mcp'
  | 'settings'
  | 'claude-md'
  | 'claude-file'
  | 'diagnostics'
  | null;

export type WorkspaceStatus = 'active' | 'idle' | 'running' | 'complete' | 'attention' | 'error';

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
  embeddedTerminalId?: string;
  restorePreference?: 'resume_latest' | 'start_fresh';
  previewUrl?: string;
  isStreaming?: boolean;
  error?: string | null;
}

export interface TerminalTab {
  id: string;
  kind: 'chat' | 'agent';
  title: string;
  titleLocked?: boolean;
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
  isInitialized: boolean;
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
  setWorkspaceOrderByIds: (orderedWorkspaceIds: string[]) => void;
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

function collectEmbeddedTerminalIds(terminal: TerminalTab): string[] {
  const ids = new Set<string>();
  Object.values(terminal.paneStates || {}).forEach((paneState) => {
    if (paneState?.embeddedTerminalId) {
      ids.add(paneState.embeddedTerminalId);
    }
  });
  return Array.from(ids);
}

function sanitizePaneRuntimeStateForHydration(
  paneState: PaneRuntimeState | undefined
): PaneRuntimeState {
  if (!paneState) {
    return {};
  }

  const { embeddedTerminalId, ...rest } = paneState;
  void embeddedTerminalId;
  return rest;
}

export function sanitizeTerminalForHydration(terminal: TerminalTab): TerminalTab {
  const nextPaneStates = Object.entries(terminal.paneStates || {}).reduce<Record<string, PaneRuntimeState>>(
    (acc, [paneId, paneState]) => {
      acc[paneId] = sanitizePaneRuntimeStateForHydration(paneState);
      return acc;
    },
    {}
  );

  return {
    ...terminal,
    paneStates: nextPaneStates,
  };
}

function stableSerializeWorkspace(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current instanceof Date) {
      return current.toISOString();
    }
    return current;
  });
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
    titleLocked: false,
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
  | { type: 'set-workspace-order-by-ids'; orderedIds: string[] }
  | { type: 'reorder-workspaces'; startIndex: number; endIndex: number }
  | { type: 'create-terminal'; workspaceId: string; terminal: TerminalTab }
  | { type: 'close-terminal'; workspaceId: string; terminalTabId: string }
  | { type: 'set-active-terminal'; workspaceId: string; terminalTabId: string }
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

export function orderWorkspacesByIds(tabs: Tab[], orderedIds: string[]): Tab[] {
  if (orderedIds.length === 0) {
    return tabs.map((tab, index) => ({ ...tab, order: index }));
  }

  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered: Tab[] = [];
  const consumed = new Set<string>();

  orderedIds.forEach((id) => {
    const tab = byId.get(id);
    if (!tab || consumed.has(id)) return;
    consumed.add(id);
    ordered.push(tab);
  });

  tabs.forEach((tab) => {
    if (!consumed.has(tab.id)) {
      ordered.push(tab);
    }
  });

  return ordered.map((tab, index) => ({ ...tab, order: index }));
}

export function tabReducer(state: WorkspaceState, action: Action): WorkspaceState {
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

    case 'set-workspace-order-by-ids': {
      const tabs = orderWorkspacesByIds(state.tabs, action.orderedIds);
      const activeTabId = state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : tabs[0]?.id || null;
      return {
        ...state,
        tabs,
        activeTabId,
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

    case 'create-terminal': {
      const tabs = state.tabs.map((workspace) => {
        if (workspace.id !== action.workspaceId) {
          return workspace;
        }
        return {
          ...workspace,
          terminalTabs: [...workspace.terminalTabs, action.terminal],
          activeTerminalTabId: action.terminal.id,
          updatedAt: new Date(),
          status: 'active' as WorkspaceStatus,
        };
      });
      return {
        ...state,
        tabs,
        activeTabId: action.workspaceId,
      };
    }

    case 'close-terminal': {
      const tabs = state.tabs.map((workspace) => {
        if (workspace.id !== action.workspaceId) {
          return workspace;
        }
        const filtered = workspace.terminalTabs.filter((terminal) => terminal.id !== action.terminalTabId);
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
        return {
          ...workspace,
          terminalTabs: nextTerminalTabs,
          activeTerminalTabId,
          updatedAt: new Date(),
        };
      });
      return {
        ...state,
        tabs,
      };
    }

    case 'set-active-terminal': {
      const tabs = state.tabs.map((workspace) => {
        if (workspace.id !== action.workspaceId) {
          return workspace;
        }
        if (!workspace.terminalTabs.some((terminal) => terminal.id === action.terminalTabId)) {
          return workspace;
        }
        return {
          ...workspace,
          activeTerminalTabId: action.terminalTabId,
          updatedAt: new Date(),
        };
      });
      return {
        ...state,
        tabs,
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
  const [state, dispatch] = useReducer(tabReducer, initialState);
  const [isInitialized, setIsInitialized] = useState(false);
  const stateRef = useRef(state);
  const lastPublishedSnapshotRef = useRef<string>('');
  const lastPublishedTerminalSummaryRef = useRef<string>('');
  const lastPublishedProviderSummaryRef = useRef<string>('');

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    setTerminalWorkspaceSnapshotProvider(() => ({
      tabs: stateRef.current.tabs,
      activeTabId: stateRef.current.activeTabId,
    }));

    return () => {
      setTerminalWorkspaceSnapshotProvider(null);
    };
  }, []);

  useEffect(() => {
    void mobileSyncBridge.initializeActionBridge();
    return () => {
      mobileSyncBridge.teardownActionBridge();
    };
  }, []);

  useEffect(() => {
    const loadWorkspace = async () => {
      const { tabs: savedTabs, activeTabId } = await TabPersistenceService.loadWorkspaceWithFallback();

      const restoredTabs = savedTabs.map((workspace) => ({
        ...workspace,
        terminalTabs: workspace.terminalTabs.map((terminal) => {
          const sanitizedTerminal = sanitizeTerminalForHydration(terminal);

          if (sanitizedTerminal.kind !== 'chat' || !sanitizedTerminal.sessionState?.sessionId) {
            return sanitizedTerminal;
          }

          const sessionData = SessionPersistenceService.loadSession(sanitizedTerminal.sessionState.sessionId);
          if (!sessionData) {
            return sanitizedTerminal;
          }

          const restoredSession = SessionPersistenceService.createSessionFromRestoreData(sessionData);
          return {
            ...sanitizedTerminal,
            sessionState: {
              ...sanitizedTerminal.sessionState,
              sessionData: restoredSession,
              initialProjectPath: sanitizedTerminal.sessionState.initialProjectPath || sessionData.projectPath,
              projectPath: sanitizedTerminal.sessionState.projectPath || sessionData.projectPath,
            },
          };
        }),
      }));

      dispatch({ type: 'hydrate', tabs: restoredTabs, activeTabId });
      stateRef.current = {
        ...stateRef.current,
        tabs: restoredTabs,
        activeTabId,
      };
      logWorkspaceEvent({
        category: 'persist_load',
        action: 'hydrate_workspace',
        tabCount: restoredTabs.length,
        terminalCount: restoredTabs.reduce((count, workspace) => count + workspace.terminalTabs.length, 0),
        activeWorkspaceId: activeTabId,
        workspaceHash: hashWorkspaceState({
          tabs: restoredTabs.map((workspace) => workspace.id),
          activeTabId,
        }),
      });
      setIsInitialized(true);
    };

    loadWorkspace();
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    TabPersistenceService.saveWorkspace(state.tabs, state.activeTabId);
    logWorkspaceEvent({
      category: 'state_action',
      action: 'autosave_workspace',
      tabCount: state.tabs.length,
      activeWorkspaceId: state.activeTabId,
      workspaceHash: hashWorkspaceState({
        tabs: state.tabs.map((workspace) => workspace.id),
        activeTabId: state.activeTabId,
      }),
    });
  }, [state.tabs, state.activeTabId, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;

    const serializableState = {
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      utilityOverlay: state.utilityOverlay,
      utilityPayload: state.utilityPayload,
    };
    const snapshotHash = stableSerializeWorkspace(serializableState);
    if (snapshotHash === lastPublishedSnapshotRef.current) {
      return;
    }

    lastPublishedSnapshotRef.current = snapshotHash;
    void mobileSyncBridge.publishSnapshot(serializableState);
    const workspacePayload = buildWorkspaceStateChangedPayload(serializableState);
    const terminalSummaryPayload = buildTerminalStateSummaryPayload(serializableState);
    const providerSummaryPayload = buildProviderSessionStateSummaryPayload(serializableState);

    const events: Array<{ eventType: string; payload: unknown }> = [
      {
        eventType: 'workspace.state_changed',
        payload: workspacePayload,
      },
    ];

    const terminalSummaryKey = stableSerializeWorkspace(terminalSummaryPayload);
    if (terminalSummaryKey !== lastPublishedTerminalSummaryRef.current) {
      lastPublishedTerminalSummaryRef.current = terminalSummaryKey;
      events.push({
        eventType: 'terminal.state_summary',
        payload: terminalSummaryPayload,
      });
    }

    const providerSummaryKey = stableSerializeWorkspace(providerSummaryPayload);
    if (providerSummaryKey !== lastPublishedProviderSummaryRef.current) {
      lastPublishedProviderSummaryRef.current = providerSummaryKey;
      events.push({
        eventType: 'provider_session.state_summary',
        payload: providerSummaryPayload,
      });
    }

    void mobileSyncBridge.publishEvents(events);
  }, [
    state.tabs,
    state.activeTabId,
    state.utilityOverlay,
    state.utilityPayload,
    isInitialized,
  ]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!isInitialized) return;
      TabPersistenceService.saveWorkspace(stateRef.current.tabs, stateRef.current.activeTabId);
      void TabPersistenceService.flushPendingWorkspaceMirror();
    };

    const handleVisibilityChange = () => {
      if (!isInitialized) return;
      if (document.visibilityState !== 'hidden') return;
      TabPersistenceService.saveWorkspace(stateRef.current.tabs, stateRef.current.activeTabId);
      void TabPersistenceService.flushPendingWorkspaceMirror();
      logWorkspaceEvent({
        category: 'state_action',
        action: 'visibility_flush_workspace',
        tabCount: stateRef.current.tabs.length,
        activeWorkspaceId: stateRef.current.activeTabId,
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (isInitialized) {
        TabPersistenceService.saveWorkspace(stateRef.current.tabs, stateRef.current.activeTabId);
        void TabPersistenceService.flushPendingWorkspaceMirror();
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
    const workspace = stateRef.current.tabs.find((tab) => tab.id === id);
    workspace?.terminalTabs.forEach((terminal) => {
      collectEmbeddedTerminalIds(terminal).forEach((embeddedTerminalId) => {
        api.closeEmbeddedTerminal(embeddedTerminalId).catch(() => undefined);
      });
    });
    dispatch({ type: 'close-workspace', id });
    logWorkspaceEvent({
      category: 'state_action',
      action: 'close_workspace',
      activeWorkspaceId: id,
    });
  }, []);

  const updateProjectWorkspaceTab = useCallback((id: string, updates: Partial<Tab>) => {
    dispatch({ type: 'update-workspace', id, updates });
  }, []);

  const setActiveTab = useCallback((id: string) => {
    dispatch({ type: 'set-active-workspace', id });
  }, []);

  const setWorkspaceOrderByIds = useCallback((orderedWorkspaceIds: string[]) => {
    const nextTabs = orderWorkspacesByIds(stateRef.current.tabs, orderedWorkspaceIds);
    const nextActiveTabId =
      stateRef.current.activeTabId && nextTabs.some((tab) => tab.id === stateRef.current.activeTabId)
        ? stateRef.current.activeTabId
        : nextTabs[0]?.id || null;

    stateRef.current = {
      ...stateRef.current,
      tabs: nextTabs,
      activeTabId: nextActiveTabId,
    };

    dispatch({ type: 'set-workspace-order-by-ids', orderedIds: orderedWorkspaceIds });
    TabPersistenceService.saveWorkspace(nextTabs, nextActiveTabId);
    logWorkspaceEvent({
      category: 'reorder',
      action: 'set_workspace_order_by_ids',
      tabCount: nextTabs.length,
      activeWorkspaceId: nextActiveTabId,
      workspaceHash: hashWorkspaceState({
        orderedWorkspaceIds: nextTabs.map((tab) => tab.id),
        activeTabId: nextActiveTabId,
      }),
      payload: {
        orderedWorkspaceIds,
      },
    });
  }, []);

  const reorderTabs = useCallback((startIndex: number, endIndex: number) => {
    const currentTabs = stateRef.current.tabs;
    if (
      startIndex < 0 ||
      endIndex < 0 ||
      startIndex >= currentTabs.length ||
      endIndex >= currentTabs.length
    ) {
      return;
    }

    const next = [...currentTabs];
    const [moved] = next.splice(startIndex, 1);
    next.splice(endIndex, 0, moved);
    setWorkspaceOrderByIds(next.map((tab) => tab.id));
  }, [setWorkspaceOrderByIds]);

  const createTerminalTabForWorkspace = useCallback((workspaceId: string, input?: CreateTerminalTabInput): string => {
    const workspace = stateRef.current.tabs.find((tab) => tab.id === workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const terminal = createTerminalTab(workspace.projectPath, input);
    dispatch({ type: 'create-terminal', workspaceId, terminal });
    logWorkspaceEvent({
      category: 'state_action',
      action: 'create_terminal',
      activeWorkspaceId: workspaceId,
      activeTerminalId: terminal.id,
      payload: {
        kind: terminal.kind,
      },
    });
    return terminal.id;
  }, []);

  const closeTerminalTab = useCallback((workspaceId: string, terminalTabId: string) => {
    const workspace = stateRef.current.tabs.find((tab) => tab.id === workspaceId);
    const terminal = workspace?.terminalTabs.find((entry) => entry.id === terminalTabId);
    if (terminal) {
      collectEmbeddedTerminalIds(terminal).forEach((embeddedTerminalId) => {
        api.closeEmbeddedTerminal(embeddedTerminalId).catch(() => undefined);
      });
    }
    dispatch({ type: 'close-terminal', workspaceId, terminalTabId });
    logWorkspaceEvent({
      category: 'state_action',
      action: 'close_terminal',
      activeWorkspaceId: workspaceId,
      activeTerminalId: terminalTabId,
    });
  }, []);

  const setActiveTerminalTab = useCallback((workspaceId: string, terminalTabId: string) => {
    dispatch({ type: 'set-active-terminal', workspaceId, terminalTabId });
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
        const embeddedTerminalId = nextPaneStates[paneId]?.embeddedTerminalId;
        delete nextPaneStates[paneId];
        if (embeddedTerminalId) {
          api.closeEmbeddedTerminal(embeddedTerminalId).catch(() => undefined);
        }

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
        if (terminal.activePaneId === paneId) {
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
    stateRef.current.tabs.forEach((workspace) => {
      workspace.terminalTabs.forEach((terminal) => {
        collectEmbeddedTerminalIds(terminal).forEach((embeddedTerminalId) => {
          api.closeEmbeddedTerminal(embeddedTerminalId).catch(() => undefined);
        });
      });
    });
    dispatch({ type: 'replace-workspaces', tabs: [], activeTabId: null });
    TabPersistenceService.clearWorkspace();
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    const handleMobileAction = (event: Event) => {
      const customEvent = event as CustomEvent<{
        actionId?: string;
        actionType?: string;
        payload?: Record<string, any>;
      }>;

      const actionType = customEvent.detail?.actionType;
      const payload = customEvent.detail?.payload ?? {};
      if (!actionType) return;

      void (async () => {
        try {
          switch (actionType) {
            case 'workspace.activate':
            case 'tab.activate': {
              if (typeof payload.workspaceId === 'string') {
                setActiveTab(payload.workspaceId);
              }
              break;
            }
            case 'workspace.create': {
              createProjectWorkspaceTab(payload.projectPath || '', payload.title);
              break;
            }
            case 'terminal.activate': {
              if (typeof payload.workspaceId === 'string' && typeof payload.terminalTabId === 'string') {
                setActiveTerminalTab(payload.workspaceId, payload.terminalTabId);
              }
              break;
            }
            case 'provider_session.execute': {
              if (typeof payload.projectPath === 'string' && typeof payload.prompt === 'string') {
                await api.executeProviderSession(payload.projectPath, payload.prompt, payload.model || 'default');
              }
              break;
            }
            case 'provider_session.resume': {
              if (
                typeof payload.projectPath === 'string' &&
                typeof payload.prompt === 'string' &&
                typeof payload.sessionId === 'string'
              ) {
                await api.resumeProviderSession(
                  payload.projectPath,
                  payload.sessionId,
                  payload.prompt,
                  payload.model || 'default'
                );
              }
              break;
            }
            case 'provider_session.cancel': {
              if (typeof payload.sessionId === 'string') {
                await api.cancelProviderSession(payload.sessionId);
              } else {
                await api.cancelProviderSession();
              }
              break;
            }
            case 'terminal.write': {
              if (typeof payload.terminalId === 'string' && typeof payload.data === 'string') {
                await api.writeEmbeddedTerminalInput(payload.terminalId, payload.data);
              }
              break;
            }
            case 'terminal.resize_hint': {
              if (
                typeof payload.terminalId === 'string' &&
                typeof payload.cols === 'number' &&
                typeof payload.rows === 'number'
              ) {
                await api.resizeEmbeddedTerminal(payload.terminalId, payload.cols, payload.rows);
              }
              break;
            }
            default:
              break;
          }
        } catch (error) {
          console.error('[mobileSync] Failed to execute mobile action', actionType, error);
        }
      })();
    };

    window.addEventListener('mobile-action-requested', handleMobileAction as EventListener);
    return () => {
      window.removeEventListener('mobile-action-requested', handleMobileAction as EventListener);
    };
  }, [
    isInitialized,
    createProjectWorkspaceTab,
    setActiveTab,
    setActiveTerminalTab,
  ]);

  const value = useMemo<TabContextType>(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      isInitialized,
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
      setWorkspaceOrderByIds,
      reorderTabs,
      getTabById,
      openUtilityOverlay,
      closeUtilityOverlay,
      closeAllTabs,
    }),
    [
      state,
      isInitialized,
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
      setWorkspaceOrderByIds,
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
