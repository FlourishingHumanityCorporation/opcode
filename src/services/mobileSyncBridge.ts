import { api } from '@/lib/api';

export interface WorkspaceMirrorState {
  tabs: unknown[];
  activeTabId: string | null;
  utilityOverlay?: string | null;
  utilityPayload?: unknown;
}

export interface WorkspaceStateChangedPayload {
  activeTabId: string | null;
  activeWorkspaceId: string | null;
  activeTerminalTabId: string | null;
  activeEmbeddedTerminalId: string | null;
  activeSessionId: string | null;
  projectPath: string | null;
  workspaceCount: number;
  terminalCount: number;
  tabCount: number;
  utilityOverlay: string | null;
}

export interface TerminalStateSummaryPayload {
  activeWorkspaceId: string | null;
  activeTerminalTabId: string | null;
  activeEmbeddedTerminalId: string | null;
  status: string | null;
}

export interface ProviderSessionStateSummaryPayload {
  activeWorkspaceId: string | null;
  activeTerminalTabId: string | null;
  activeSessionId: string | null;
  projectPath: string | null;
  providerId: string | null;
}

export interface MobileSyncBridgeEvent {
  eventType: string;
  payload: unknown;
}

type UnlistenFn = () => void;

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, any>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getActiveWorkspace(state: WorkspaceMirrorState): Record<string, any> | null {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  if (tabs.length === 0) {
    return null;
  }

  const activeWorkspace = tabs.find((tab) => asRecord(tab)?.id === state.activeTabId) ?? tabs[0];
  return asRecord(activeWorkspace);
}

function getActiveTerminal(workspace: Record<string, any> | null): Record<string, any> | null {
  if (!workspace) {
    return null;
  }

  const terminals = Array.isArray(workspace.terminalTabs) ? workspace.terminalTabs : [];
  if (terminals.length === 0) {
    return null;
  }

  const activeTerminal =
    terminals.find((terminal) => asRecord(terminal)?.id === workspace.activeTerminalTabId) ?? terminals[0];
  return asRecord(activeTerminal);
}

function getActivePaneState(terminal: Record<string, any> | null): Record<string, any> | null {
  if (!terminal) {
    return null;
  }

  const paneStates = asRecord(terminal.paneStates);
  if (!paneStates) {
    return null;
  }

  if (terminal.activePaneId && paneStates[terminal.activePaneId]) {
    return asRecord(paneStates[terminal.activePaneId]);
  }

  const firstPane = Object.values(paneStates)[0];
  return asRecord(firstPane);
}

export function buildWorkspaceStateChangedPayload(
  state: WorkspaceMirrorState
): WorkspaceStateChangedPayload {
  const activeWorkspace = getActiveWorkspace(state);
  const activeTerminal = getActiveTerminal(activeWorkspace);
  const activePaneState = getActivePaneState(activeTerminal);
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const terminalCount = tabs.reduce<number>((count, tab) => {
    const workspace = asRecord(tab);
    return count + (Array.isArray(workspace?.terminalTabs) ? workspace.terminalTabs.length : 0);
  }, 0);

  const sessionState = asRecord(activeTerminal?.sessionState);
  const activeSessionId = asString(sessionState?.sessionId) ?? asString(activePaneState?.sessionId);
  const projectPath =
    asString(activeWorkspace?.projectPath) ??
    asString(sessionState?.projectPath) ??
    asString(sessionState?.initialProjectPath) ??
    asString(activePaneState?.projectPath);

  return {
    activeTabId: state.activeTabId,
    activeWorkspaceId: asString(activeWorkspace?.id),
    activeTerminalTabId: asString(activeTerminal?.id),
    activeEmbeddedTerminalId: asString(activePaneState?.embeddedTerminalId),
    activeSessionId,
    projectPath,
    workspaceCount: tabs.length,
    terminalCount,
    tabCount: tabs.length,
    utilityOverlay: asString(state.utilityOverlay) ?? null,
  };
}

export function buildTerminalStateSummaryPayload(
  state: WorkspaceMirrorState
): TerminalStateSummaryPayload {
  const activeWorkspace = getActiveWorkspace(state);
  const activeTerminal = getActiveTerminal(activeWorkspace);
  const activePaneState = getActivePaneState(activeTerminal);

  return {
    activeWorkspaceId: asString(activeWorkspace?.id),
    activeTerminalTabId: asString(activeTerminal?.id),
    activeEmbeddedTerminalId: asString(activePaneState?.embeddedTerminalId),
    status: asString(activeTerminal?.status),
  };
}

export function buildProviderSessionStateSummaryPayload(
  state: WorkspaceMirrorState
): ProviderSessionStateSummaryPayload {
  const activeWorkspace = getActiveWorkspace(state);
  const activeTerminal = getActiveTerminal(activeWorkspace);
  const activePaneState = getActivePaneState(activeTerminal);
  const sessionState = asRecord(activeTerminal?.sessionState);
  const activeSessionId = asString(sessionState?.sessionId) ?? asString(activePaneState?.sessionId);

  return {
    activeWorkspaceId: asString(activeWorkspace?.id),
    activeTerminalTabId: asString(activeTerminal?.id),
    activeSessionId,
    projectPath:
      asString(activeWorkspace?.projectPath) ??
      asString(sessionState?.projectPath) ??
      asString(sessionState?.initialProjectPath) ??
      asString(activePaneState?.projectPath),
    providerId: asString(activeTerminal?.providerId) ?? asString(activePaneState?.providerId),
  };
}

function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).__TAURI__ || (window as any).__TAURI_METADATA__);
}

function toSerializable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, current) => {
      if (current instanceof Date) {
        return current.toISOString();
      }
      return current;
    })
  ) as T;
}

class MobileSyncBridge {
  private snapshotInFlight = false;
  private actionUnlisten: UnlistenFn | null = null;

  async initializeActionBridge(): Promise<void> {
    if (!isDesktopRuntime()) return;
    if (this.actionUnlisten) return;

    try {
      const tauriEvent = await import('@tauri-apps/api/event');
      const unlisten = await tauriEvent.listen('mobile-action-requested', (event) => {
        window.dispatchEvent(
          new CustomEvent('mobile-action-requested', {
            detail: event.payload,
          })
        );
      });

      this.actionUnlisten = () => {
        unlisten();
      };
    } catch (error) {
      console.warn('[mobileSyncBridge] Failed to initialize action bridge:', error);
    }
  }

  teardownActionBridge(): void {
    if (!this.actionUnlisten) return;
    this.actionUnlisten();
    this.actionUnlisten = null;
  }

  async publishSnapshot(state: WorkspaceMirrorState): Promise<void> {
    if (!isDesktopRuntime()) return;
    if (this.snapshotInFlight) return;

    this.snapshotInFlight = true;
    try {
      const snapshot = toSerializable({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        utilityOverlay: state.utilityOverlay ?? null,
        utilityPayload: state.utilityPayload ?? null,
      });
      await api.mobileSyncPublishSnapshot(snapshot as Record<string, any>);
    } catch (error) {
      console.warn('[mobileSyncBridge] Failed to publish snapshot:', error);
    } finally {
      this.snapshotInFlight = false;
    }
  }

  async publishEvents(events: MobileSyncBridgeEvent[]): Promise<void> {
    if (!isDesktopRuntime()) return;
    if (events.length === 0) return;

    try {
      await api.mobileSyncPublishEvents(
        events.map((event) => ({
          eventType: event.eventType,
          payload: toSerializable(event.payload),
        }))
      );
    } catch (error) {
      console.warn('[mobileSyncBridge] Failed to publish events:', error);
    }
  }
}

export const mobileSyncBridge = new MobileSyncBridge();
