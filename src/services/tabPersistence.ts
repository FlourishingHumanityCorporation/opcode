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
import { api } from '@/lib/api';
import { hashWorkspaceState, logWorkspaceEvent } from '@/services/workspaceDiagnostics';
import { logger } from '@/lib/logger';

const STORAGE_KEY = 'opcode_workspace_v3';
const WORKSPACE_DB_MIRROR_KEY = 'workspace_state_v3';
const PERSISTENCE_ENABLED_KEY = 'opcode_tab_persistence_enabled';
const EMBEDDED_TERMINAL_RUNTIME_MIGRATION_KEY = 'opcode_embedded_terminal_runtime_migration_v1';
const DB_MIRROR_DEBOUNCE_MS = 300;

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
  titleLocked?: boolean;
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

function migrateEmbeddedTerminalRuntimeIds(
  workspace: SerializedWorkspace
): { workspace: SerializedWorkspace; updated: boolean } {
  let updated = false;

  const tabs = workspace.tabs.map((tab) => ({
    ...tab,
    terminalTabs: tab.terminalTabs.map((terminal) => {
      const paneStates = Object.entries(terminal.paneStates || {}).reduce<
        TerminalTab['paneStates']
      >((acc, [paneId, paneState]) => {
        if (!paneState || typeof paneState !== 'object') {
          acc[paneId] = paneState as TerminalTab['paneStates'][string];
          return acc;
        }

        const paneRecord = paneState as Record<string, unknown>;
        if (!('embeddedTerminalId' in paneRecord)) {
          acc[paneId] = paneState as TerminalTab['paneStates'][string];
          return acc;
        }

        const { embeddedTerminalId, ...rest } = paneRecord;
        void embeddedTerminalId;
        acc[paneId] = rest as TerminalTab['paneStates'][string];
        updated = true;
        return acc;
      }, {});

      return {
        ...terminal,
        paneStates,
      };
    }),
  }));

  return {
    workspace: {
      ...workspace,
      tabs,
    },
    updated,
  };
}

export interface WorkspaceValidationResult {
  valid: boolean;
  errors: string[];
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

function countTerminalTabs(tabs: ProjectWorkspaceTab[]): number {
  return tabs.reduce((count, workspace) => count + workspace.terminalTabs.length, 0);
}

function deserializeWorkspacePayload(
  parsed: SerializedWorkspace
): { tabs: ProjectWorkspaceTab[]; activeTabId: string | null } {
  const tabs = parsed.tabs
    .map(deserializeWorkspace)
    .filter((tab) => tab.id && tab.type === 'project')
    .sort((a, b) => a.order - b.order)
    .map((tab, index) => ({ ...tab, order: index }));

  const activeTabId = parsed.activeTabId && tabs.some((tab) => tab.id === parsed.activeTabId)
    ? parsed.activeTabId
    : tabs[0]?.id ?? null;

  return { tabs, activeTabId };
}

export function validateWorkspaceGraph(
  tabs: ProjectWorkspaceTab[],
  activeTabId: string | null
): WorkspaceValidationResult {
  const errors: string[] = [];

  if (activeTabId && !tabs.some((workspace) => workspace.id === activeTabId)) {
    errors.push(`Active workspace ${activeTabId} is missing`);
  }

  tabs.forEach((workspace) => {
    if (workspace.terminalTabs.length === 0) {
      errors.push(`Workspace ${workspace.id} has no terminal tabs`);
      return;
    }

    if (
      workspace.activeTerminalTabId &&
      !workspace.terminalTabs.some((terminal) => terminal.id === workspace.activeTerminalTabId)
    ) {
      errors.push(`Workspace ${workspace.id} active terminal ${workspace.activeTerminalTabId} is missing`);
    }

    workspace.terminalTabs.forEach((terminal) => {
      if (!isPaneNode(terminal.paneTree)) {
        errors.push(`Terminal ${terminal.id} has invalid pane tree`);
        return;
      }

      const leaves = collectLeafIds(terminal.paneTree);
      if (leaves.length === 0) {
        errors.push(`Terminal ${terminal.id} has no leaf panes`);
      } else if (!leaves.includes(terminal.activePaneId)) {
        errors.push(`Terminal ${terminal.id} active pane ${terminal.activePaneId} is missing`);
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
  };
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
    titleLocked: Boolean(serialized.titleLocked),
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
      titleLocked: Boolean(terminal.titleLocked),
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
    titleLocked: false,
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
  private static pendingWorkspaceMirrorPayload: string | null = null;
  private static mirrorFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static mirrorWriteInFlight = false;
  private static lastMirroredWorkspacePayload: string | null = null;

  private static queueWorkspaceMirror(serializedPayload: string): void {
    if (!this.isEnabled()) {
      return;
    }
    if (
      serializedPayload === this.lastMirroredWorkspacePayload &&
      this.pendingWorkspaceMirrorPayload === null
    ) {
      return;
    }

    this.pendingWorkspaceMirrorPayload = serializedPayload;
    if (this.mirrorFlushTimer) {
      clearTimeout(this.mirrorFlushTimer);
    }
    this.mirrorFlushTimer = setTimeout(() => {
      this.mirrorFlushTimer = null;
      void this.persistPendingWorkspaceMirror();
    }, DB_MIRROR_DEBOUNCE_MS);
  }

  private static async persistPendingWorkspaceMirror(): Promise<void> {
    if (this.mirrorWriteInFlight) {
      return;
    }

    const payload = this.pendingWorkspaceMirrorPayload;
    if (payload === null || payload === this.lastMirroredWorkspacePayload) {
      this.pendingWorkspaceMirrorPayload = null;
      return;
    }

    this.pendingWorkspaceMirrorPayload = null;
    this.mirrorWriteInFlight = true;
    try {
      await api.saveSetting(WORKSPACE_DB_MIRROR_KEY, payload);
      this.lastMirroredWorkspacePayload = payload;
      logWorkspaceEvent({
        category: 'persist_save',
        action: 'save_workspace_db_mirror',
      });
    } catch (error) {
      logger.warn('misc', 'Failed to mirror workspace to app settings:', { value: error });
      logWorkspaceEvent({
        category: 'error',
        action: 'save_workspace_db_mirror_failed',
        message: error instanceof Error ? error.message : 'Unknown db mirror error',
      });
    } finally {
      this.mirrorWriteInFlight = false;
    }

    if (
      this.pendingWorkspaceMirrorPayload !== null &&
      this.pendingWorkspaceMirrorPayload !== this.lastMirroredWorkspacePayload
    ) {
      await this.persistPendingWorkspaceMirror();
    }
  }

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
      const orderedTabs = tabs.map((tab, index) => ({ ...tab, order: index }));

      const payload: SerializedWorkspace = {
        version: 3,
        tabs: orderedTabs.map(serializeWorkspaceTab),
        activeTabId: activeTabId && orderedTabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : orderedTabs[0]?.id ?? null,
      };

      const serializedPayload = JSON.stringify(payload);
      localStorage.setItem(STORAGE_KEY, serializedPayload);
      this.queueWorkspaceMirror(serializedPayload);
      logWorkspaceEvent({
        category: 'persist_save',
        action: 'save_workspace',
        workspaceHash: hashWorkspaceState(payload),
        activeWorkspaceId: payload.activeTabId,
        tabCount: orderedTabs.length,
        terminalCount: countTerminalTabs(orderedTabs),
      });
    } catch (error) {
      logger.error('persistence', 'Failed to save workspace:', { error });
      logWorkspaceEvent({
        category: 'error',
        action: 'persist_save_failed',
        message: error instanceof Error ? error.message : 'Unknown save error',
      });
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

      let parsed = JSON.parse(raw) as SerializedWorkspace;
      if (!parsed || parsed.version !== 3 || !Array.isArray(parsed.tabs)) {
        throw new Error('Invalid workspace schema');
      }

      const runtimeMigrationDone = localStorage.getItem(EMBEDDED_TERMINAL_RUNTIME_MIGRATION_KEY) === '1';
      if (!runtimeMigrationDone) {
        const migration = migrateEmbeddedTerminalRuntimeIds(parsed);
        if (migration.updated) {
          parsed = migration.workspace;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
          logWorkspaceEvent({
            category: 'persist_migration',
            action: 'migrate_clear_embedded_terminal_runtime_ids_v1',
            workspaceHash: hashWorkspaceState(parsed),
            activeWorkspaceId: parsed.activeTabId,
            tabCount: parsed.tabs.length,
            terminalCount: parsed.tabs.reduce((count, tab) => count + tab.terminalTabs.length, 0),
          });
        }
        localStorage.setItem(EMBEDDED_TERMINAL_RUNTIME_MIGRATION_KEY, '1');
      }

      const { tabs, activeTabId } = deserializeWorkspacePayload(parsed);

      const validation = validateWorkspaceGraph(tabs, activeTabId);
      if (!validation.valid) {
        throw new Error(`Invalid workspace graph: ${validation.errors.join('; ')}`);
      }

      logWorkspaceEvent({
        category: 'persist_load',
        action: 'load_workspace',
        workspaceHash: hashWorkspaceState(parsed),
        activeWorkspaceId: activeTabId,
        tabCount: tabs.length,
        terminalCount: countTerminalTabs(tabs),
      });

      return { tabs, activeTabId };
    } catch (error) {
      logger.error('persistence', 'Failed to load workspace:', { error });
      const raw = localStorage.getItem(STORAGE_KEY);
      logWorkspaceEvent({
        category: 'error',
        action: 'persist_load_failed',
        message: error instanceof Error ? error.message : 'Unknown load error',
        payload: {
          rawSize: raw?.length ?? 0,
        },
      });
      localStorage.removeItem(STORAGE_KEY);
      return { tabs: [], activeTabId: null };
    }
  }

  static async loadWorkspaceWithFallback(): Promise<{ tabs: ProjectWorkspaceTab[]; activeTabId: string | null }> {
    const localResult = this.loadWorkspace();
    if (!this.isEnabled()) {
      return localResult;
    }
    if (localResult.tabs.length > 0 || localResult.activeTabId !== null) {
      return localResult;
    }

    try {
      const mirroredPayload = await api.getSetting(WORKSPACE_DB_MIRROR_KEY, { fresh: true });
      if (!mirroredPayload) {
        const legacyPayload = typeof api.storageFindLegacyWorkspaceState === 'function'
          ? await api.storageFindLegacyWorkspaceState()
          : null;
        if (!legacyPayload) {
          return localResult;
        }

        const parsedLegacy = JSON.parse(legacyPayload) as SerializedWorkspace;
        if (!parsedLegacy || parsedLegacy.version !== 3 || !Array.isArray(parsedLegacy.tabs)) {
          throw new Error('Invalid legacy workspace schema');
        }

        localStorage.setItem(STORAGE_KEY, legacyPayload);
        const restoredFromLegacy = this.loadWorkspace();
        if (restoredFromLegacy.tabs.length > 0 || restoredFromLegacy.activeTabId !== null) {
          this.lastMirroredWorkspacePayload = legacyPayload;
          try {
            await api.saveSetting(WORKSPACE_DB_MIRROR_KEY, legacyPayload);
          } catch (persistError) {
            logWorkspaceEvent({
              category: 'error',
              action: 'persist_legacy_workspace_to_db_failed',
              message: persistError instanceof Error ? persistError.message : 'Unknown legacy persist error',
            });
          }
          logWorkspaceEvent({
            category: 'persist_migration',
            action: 'restore_workspace_from_legacy_storage',
            tabCount: restoredFromLegacy.tabs.length,
            terminalCount: countTerminalTabs(restoredFromLegacy.tabs),
            activeWorkspaceId: restoredFromLegacy.activeTabId,
          });
        }
        return restoredFromLegacy;
      }

      const parsed = JSON.parse(mirroredPayload) as SerializedWorkspace;
      if (!parsed || parsed.version !== 3 || !Array.isArray(parsed.tabs)) {
        throw new Error('Invalid mirrored workspace schema');
      }
      if (parsed.tabs.length === 0) {
        const legacyPayload = typeof api.storageFindLegacyWorkspaceState === 'function'
          ? await api.storageFindLegacyWorkspaceState()
          : null;
        if (!legacyPayload) {
          return localResult;
        }

        const parsedLegacy = JSON.parse(legacyPayload) as SerializedWorkspace;
        if (!parsedLegacy || parsedLegacy.version !== 3 || !Array.isArray(parsedLegacy.tabs)) {
          throw new Error('Invalid legacy workspace schema');
        }

        localStorage.setItem(STORAGE_KEY, legacyPayload);
        const restoredFromLegacy = this.loadWorkspace();
        if (restoredFromLegacy.tabs.length > 0 || restoredFromLegacy.activeTabId !== null) {
          this.lastMirroredWorkspacePayload = legacyPayload;
          try {
            await api.saveSetting(WORKSPACE_DB_MIRROR_KEY, legacyPayload);
          } catch (persistError) {
            logWorkspaceEvent({
              category: 'error',
              action: 'persist_legacy_workspace_to_db_failed',
              message: persistError instanceof Error ? persistError.message : 'Unknown legacy persist error',
            });
          }
          logWorkspaceEvent({
            category: 'persist_migration',
            action: 'restore_workspace_from_legacy_storage',
            tabCount: restoredFromLegacy.tabs.length,
            terminalCount: countTerminalTabs(restoredFromLegacy.tabs),
            activeWorkspaceId: restoredFromLegacy.activeTabId,
          });
        }
        return restoredFromLegacy;
      }

      localStorage.setItem(STORAGE_KEY, mirroredPayload);
      const restored = this.loadWorkspace();
      if (restored.tabs.length > 0 || restored.activeTabId !== null) {
        this.lastMirroredWorkspacePayload = mirroredPayload;
        logWorkspaceEvent({
          category: 'persist_migration',
          action: 'restore_workspace_from_db_mirror',
          tabCount: restored.tabs.length,
          terminalCount: countTerminalTabs(restored.tabs),
          activeWorkspaceId: restored.activeTabId,
        });
      }
      return restored;
    } catch (error) {
      logWorkspaceEvent({
        category: 'error',
        action: 'restore_workspace_from_db_mirror_failed',
        message: error instanceof Error ? error.message : 'Unknown db mirror restore error',
      });
      return localResult;
    }
  }

  static async flushPendingWorkspaceMirror(): Promise<void> {
    if (this.mirrorFlushTimer) {
      clearTimeout(this.mirrorFlushTimer);
      this.mirrorFlushTimer = null;
    }
    await this.persistPendingWorkspaceMirror();
  }

  static clearWorkspace(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.pendingWorkspaceMirrorPayload = '';
    if (this.mirrorFlushTimer) {
      clearTimeout(this.mirrorFlushTimer);
      this.mirrorFlushTimer = null;
    }
    void this.persistPendingWorkspaceMirror();
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

      const serializedPayload = JSON.stringify(migratedWorkspace);
      localStorage.setItem(STORAGE_KEY, serializedPayload);
      this.queueWorkspaceMirror(serializedPayload);
      logWorkspaceEvent({
        category: 'persist_migration',
        action: 'migrate_v2_to_v3',
        workspaceHash: hashWorkspaceState(migratedWorkspace),
        activeWorkspaceId: activeTabId,
        tabCount: migratedTabs.length,
        terminalCount: countTerminalTabs(migratedTabs),
      });
    } catch (error) {
      logger.error('persistence', 'Failed to migrate workspace from v2:', { error });
      logWorkspaceEvent({
        category: 'error',
        action: 'persist_migration_failed',
        message: error instanceof Error ? error.message : 'Unknown migration error',
      });
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  static inspectStoredWorkspace(): {
    found: boolean;
    rawSize: number;
    activeTabId: string | null;
    tabCount: number;
    terminalCount: number;
    validation: WorkspaceValidationResult;
  } {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        found: false,
        rawSize: 0,
        activeTabId: null,
        tabCount: 0,
        terminalCount: 0,
        validation: { valid: true, errors: [] },
      };
    }

    try {
      const parsed = JSON.parse(raw) as SerializedWorkspace;
      const { tabs, activeTabId } = deserializeWorkspacePayload(parsed);
      const validation = validateWorkspaceGraph(tabs, activeTabId);
      return {
        found: true,
        rawSize: raw.length,
        activeTabId,
        tabCount: tabs.length,
        terminalCount: countTerminalTabs(tabs),
        validation,
      };
    } catch (error) {
      return {
        found: true,
        rawSize: raw.length,
        activeTabId: null,
        tabCount: 0,
        terminalCount: 0,
        validation: {
          valid: false,
          errors: [error instanceof Error ? error.message : 'Failed to parse stored workspace'],
        },
      };
    }
  }
}
