/**
 * Workspace persistence service (v3)
 * Stores project workspaces with nested terminal tabs and pane trees.
 */

import type {
  PaneNode,
  ProjectWorkspaceTab,
  Tab,
  TerminalTab,
} from '@/contexts/TabContext';

const STORAGE_KEY = 'opcode_workspace_v3';
const PERSISTENCE_ENABLED_KEY = 'opcode_tab_persistence_enabled';

const LEGACY_STORAGE_KEY = 'opcode_tabs_v2';
const LEGACY_ACTIVE_TAB_KEY = 'opcode_active_tab_v2';
const LEGACY_V1_STORAGE_KEY = 'opcode_tabs';

interface SerializedWorkspace {
  version: 3;
  tabs: SerializedWorkspaceTab[];
  activeTabId: string | null;
}

interface SerializedWorkspaceTab {
  id: string;
  type: 'project';
  projectPath: string;
  title: string;
  activeTerminalTabId: string | null;
  terminalTabs: SerializedTerminalTab[];
  status: Tab['status'];
  hasUnsavedChanges: boolean;
  order: number;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

interface SerializedTerminalTab {
  id: string;
  kind: TerminalTab['kind'];
  title: string;
  providerId?: string;
  sessionState?: TerminalTab['sessionState'];
  paneTree: PaneNode;
  activePaneId: string;
  paneStates: TerminalTab['paneStates'];
  status: TerminalTab['status'];
  hasUnsavedChanges: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LegacyTabV2 {
  id: string;
  type:
    | 'chat'
    | 'agent'
    | 'agents'
    | 'projects'
    | 'usage'
    | 'mcp'
    | 'settings'
    | 'claude-md'
    | 'claude-file'
    | 'agent-execution'
    | 'create-agent'
    | 'import-agent';
  title: string;
  sessionId?: string;
  initialProjectPath?: string;
  projectPath?: string;
  providerId?: string;
  status?: Tab['status'];
  hasUnsavedChanges?: boolean;
  order?: number;
  icon?: string;
  createdAt?: string;
  updatedAt?: string;
}

function parseDate(value: string | Date | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function createLeafNode(id: string): PaneNode {
  return {
    id,
    type: 'leaf',
    leafSessionId: id,
  };
}

function basename(path: string): string {
  if (!path) return 'Project';
  const normalized = path.replace(/\\+/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Project';
}

function isPaneNode(node: unknown): node is PaneNode {
  if (!node || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  if (record.type === 'leaf') {
    return typeof record.id === 'string' && typeof record.leafSessionId === 'string';
  }

  if (record.type === 'split') {
    return (
      typeof record.id === 'string' &&
      record.direction === 'vertical' &&
      typeof record.widthRatio === 'number' &&
      isPaneNode(record.left) &&
      isPaneNode(record.right)
    );
  }

  return false;
}

function sanitizePaneTree(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    return {
      id: node.id,
      type: 'leaf',
      leafSessionId: node.leafSessionId || node.id,
    };
  }

  const ratio = Number.isFinite(node.widthRatio) ? Math.min(90, Math.max(10, node.widthRatio)) : 50;
  return {
    id: node.id,
    type: 'split',
    direction: 'vertical',
    left: sanitizePaneTree(node.left),
    right: sanitizePaneTree(node.right),
    widthRatio: ratio,
  };
}

function collectLeafIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return [node.id];
  }
  return [...collectLeafIds(node.left), ...collectLeafIds(node.right)];
}

function deserializeTerminal(serialized: SerializedTerminalTab): TerminalTab {
  const paneTree = sanitizePaneTree(serialized.paneTree);
  const leafIds = collectLeafIds(paneTree);
  const activePaneId = leafIds.includes(serialized.activePaneId) ? serialized.activePaneId : leafIds[0];

  const paneStates = serialized.paneStates && typeof serialized.paneStates === 'object'
    ? serialized.paneStates
    : {};

  return {
    id: serialized.id,
    kind: serialized.kind,
    title: serialized.title,
    providerId: serialized.providerId,
    sessionState: serialized.sessionState,
    paneTree,
    activePaneId,
    paneStates,
    status: serialized.status,
    hasUnsavedChanges: Boolean(serialized.hasUnsavedChanges),
    createdAt: parseDate(serialized.createdAt),
    updatedAt: parseDate(serialized.updatedAt),
  };
}

function deserializeWorkspace(serialized: SerializedWorkspaceTab): ProjectWorkspaceTab {
  const terminalTabs = Array.isArray(serialized.terminalTabs)
    ? serialized.terminalTabs
        .filter((terminal) => isPaneNode(terminal.paneTree))
        .map(deserializeTerminal)
    : [];

  const activeTerminalTabId = terminalTabs.some((terminal) => terminal.id === serialized.activeTerminalTabId)
    ? serialized.activeTerminalTabId
    : terminalTabs[0]?.id ?? null;

  return {
    id: serialized.id,
    type: 'project',
    projectPath: serialized.projectPath || '',
    title: serialized.title || basename(serialized.projectPath || ''),
    activeTerminalTabId,
    terminalTabs,
    status: serialized.status,
    hasUnsavedChanges: Boolean(serialized.hasUnsavedChanges),
    order: serialized.order,
    icon: serialized.icon,
    createdAt: parseDate(serialized.createdAt),
    updatedAt: parseDate(serialized.updatedAt),
  };
}

function serializeWorkspaceTab(tab: ProjectWorkspaceTab): SerializedWorkspaceTab {
  return {
    id: tab.id,
    type: 'project',
    projectPath: tab.projectPath,
    title: tab.title,
    activeTerminalTabId: tab.activeTerminalTabId,
    terminalTabs: tab.terminalTabs.map((terminal) => ({
      id: terminal.id,
      kind: terminal.kind,
      title: terminal.title,
      providerId: terminal.providerId,
      sessionState: terminal.sessionState,
      paneTree: terminal.paneTree,
      activePaneId: terminal.activePaneId,
      paneStates: terminal.paneStates,
      status: terminal.status,
      hasUnsavedChanges: false,
      createdAt: toIso(terminal.createdAt),
      updatedAt: toIso(terminal.updatedAt),
    })),
    status: tab.status === 'running' ? 'idle' : tab.status,
    hasUnsavedChanges: false,
    order: tab.order,
    icon: tab.icon,
    createdAt: toIso(tab.createdAt),
    updatedAt: toIso(tab.updatedAt),
  };
}

function makeLegacyWorkspaceFromTab(tab: LegacyTabV2, index: number): ProjectWorkspaceTab | null {
  if (tab.type !== 'projects' && tab.type !== 'chat') {
    return null;
  }

  const projectPath = tab.initialProjectPath || tab.projectPath || '';
  const now = new Date();
  const createdAt = parseDate(tab.createdAt);
  const updatedAt = parseDate(tab.updatedAt);

  const baseTitle = tab.type === 'chat'
    ? basename(projectPath || tab.title)
    : (tab.title && tab.title !== 'Projects' ? tab.title : basename(projectPath));

  const leafId = `${tab.id}-pane-1`;
  const terminalId = `${tab.id}-terminal-1`;

  const terminal: TerminalTab = {
    id: terminalId,
    kind: 'chat',
    title: tab.type === 'chat' ? (tab.title || 'Terminal') : 'Terminal 1',
    providerId: tab.providerId,
    sessionState: {
      sessionId: tab.sessionId,
      initialProjectPath: projectPath || undefined,
      providerId: tab.providerId,
      sessionData: undefined,
    },
    paneTree: createLeafNode(leafId),
    activePaneId: leafId,
    paneStates: {},
    status: tab.status ?? 'idle',
    hasUnsavedChanges: Boolean(tab.hasUnsavedChanges),
    createdAt,
    updatedAt,
  };

  return {
    id: tab.id,
    type: 'project',
    projectPath,
    title: baseTitle || `Project ${index + 1}`,
    activeTerminalTabId: terminal.id,
    terminalTabs: [terminal],
    status: tab.status ?? 'idle',
    hasUnsavedChanges: Boolean(tab.hasUnsavedChanges),
    order: typeof tab.order === 'number' ? tab.order : index,
    icon: tab.icon,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
}

export class TabPersistenceService {
  static isEnabled(): boolean {
    const enabled = localStorage.getItem(PERSISTENCE_ENABLED_KEY);
    return enabled === null || enabled === 'true';
  }

  static setEnabled(enabled: boolean): void {
    localStorage.setItem(PERSISTENCE_ENABLED_KEY, String(enabled));
    if (!enabled) {
      this.clearWorkspace();
    }
  }

  static saveWorkspace(tabs: ProjectWorkspaceTab[], activeTabId: string | null): void {
    if (!this.isEnabled()) return;

    try {
      const orderedTabs = [...tabs]
        .sort((a, b) => a.order - b.order)
        .map((tab, index) => ({ ...tab, order: index }));

      const payload: SerializedWorkspace = {
        version: 3,
        tabs: orderedTabs.map(serializeWorkspaceTab),
        activeTabId: activeTabId && orderedTabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : orderedTabs[0]?.id ?? null,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.error('Failed to save workspace:', error);
    }
  }

  static loadWorkspace(): { tabs: ProjectWorkspaceTab[]; activeTabId: string | null } {
    if (!this.isEnabled()) {
      return { tabs: [], activeTabId: null };
    }

    this.migrateFromOldFormat();

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { tabs: [], activeTabId: null };
      }

      const parsed = JSON.parse(raw) as SerializedWorkspace;
      if (!parsed || parsed.version !== 3 || !Array.isArray(parsed.tabs)) {
        throw new Error('Invalid workspace schema');
      }

      const tabs = parsed.tabs
        .map(deserializeWorkspace)
        .filter((tab) => tab.id && tab.type === 'project')
        .sort((a, b) => a.order - b.order)
        .map((tab, index) => ({ ...tab, order: index }));

      const activeTabId = parsed.activeTabId && tabs.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[0]?.id ?? null;

      return { tabs, activeTabId };
    } catch (error) {
      console.error('Failed to load workspace:', error);
      this.clearWorkspace();
      return { tabs: [], activeTabId: null };
    }
  }

  static clearWorkspace(): void {
    localStorage.removeItem(STORAGE_KEY);
  }

  static migrateFromOldFormat(): void {
    if (localStorage.getItem(STORAGE_KEY)) {
      return;
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY) || localStorage.getItem(LEGACY_V1_STORAGE_KEY);
    if (!legacyRaw) {
      return;
    }

    try {
      const legacyTabs = JSON.parse(legacyRaw) as LegacyTabV2[];
      if (!Array.isArray(legacyTabs)) {
        return;
      }

      const sortedLegacyTabs = [...legacyTabs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const migratedTabs = sortedLegacyTabs
        .map(makeLegacyWorkspaceFromTab)
        .filter((tab): tab is ProjectWorkspaceTab => Boolean(tab))
        .map((tab, index) => ({ ...tab, order: index }));

      const legacyActiveTabId = localStorage.getItem(LEGACY_ACTIVE_TAB_KEY);
      const activeTabId = legacyActiveTabId && migratedTabs.some((tab) => tab.id === legacyActiveTabId)
        ? legacyActiveTabId
        : migratedTabs[0]?.id ?? null;

      const migratedWorkspace: SerializedWorkspace = {
        version: 3,
        tabs: migratedTabs.map(serializeWorkspaceTab),
        activeTabId,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(migratedWorkspace));
    } catch (error) {
      console.error('Failed to migrate workspace from v2:', error);
      localStorage.removeItem(STORAGE_KEY);
    }
  }
}
