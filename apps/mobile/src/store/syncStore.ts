import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import type { EventEnvelopeV1, SnapshotV1 } from '../../../../packages/mobile-sync-protocol/src';
import type { MobileSyncCredentials } from '../protocol/client';

const CREDENTIALS_KEY = 'codeinterfacex.mobile.credentials.v1';

export interface MirrorPaneState {
  embeddedTerminalId?: string;
  sessionId?: string;
  projectPath?: string;
  providerId?: string;
  isStreaming?: boolean;
  error?: string | null;
}

export interface MirrorTerminal {
  id: string;
  kind: 'chat' | 'agent';
  title: string;
  status?: string;
  providerId?: string;
  activePaneId?: string;
  paneStates: Record<string, MirrorPaneState>;
  sessionState?: {
    sessionId?: string;
    projectPath?: string;
    initialProjectPath?: string;
    providerId?: string;
  };
}

export interface MirrorWorkspace {
  id: string;
  title: string;
  projectPath: string;
  status?: string;
  activeTerminalTabId: string | null;
  terminalTabs: MirrorTerminal[];
}

export interface MirrorState {
  tabs: MirrorWorkspace[];
  activeTabId: string | null;
  utilityOverlay?: string | null;
  activeContext: ActiveContextSummary;
}

export interface ActiveContextSummary {
  activeWorkspaceId: string | null;
  activeTerminalTabId: string | null;
  activeEmbeddedTerminalId: string | null;
  activeSessionId: string | null;
  projectPath: string | null;
  workspaceCount: number;
  terminalCount: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function hasId<T extends { id: string }>(value: T | null): value is T {
  return Boolean(value?.id);
}

function deriveMirrorState(snapshot: SnapshotV1): MirrorState {
  const state = asObject(snapshot.state) || {};
  const rawTabs = Array.isArray(state.tabs) ? state.tabs : [];

  const tabs: MirrorWorkspace[] = rawTabs
    .map((rawTab) => {
      const tab = asObject(rawTab);
      if (!tab) return null;

      const rawTerminalTabs = Array.isArray(tab.terminalTabs) ? tab.terminalTabs : [];
      const terminalTabs: MirrorTerminal[] = rawTerminalTabs
        .map((rawTerminal) => {
          const terminal = asObject(rawTerminal);
          if (!terminal) return null;

          const paneStatesRecord = asObject(terminal.paneStates) || {};
          const paneStates: Record<string, MirrorPaneState> = {};

          Object.entries(paneStatesRecord).forEach(([paneId, rawPaneState]) => {
            const paneState = asObject(rawPaneState) || {};
            paneStates[paneId] = {
              embeddedTerminalId: asString(paneState.embeddedTerminalId),
              sessionId: asString(paneState.sessionId),
              projectPath: asString(paneState.projectPath),
              providerId: asString(paneState.providerId),
              isStreaming: asBoolean(paneState.isStreaming),
              error:
                typeof paneState.error === 'string' || paneState.error === null
                  ? (paneState.error as string | null)
                  : undefined,
            };
          });

          const sessionStateRaw = asObject(terminal.sessionState);

          const mapped: MirrorTerminal = {
            id: asString(terminal.id) || '',
            kind: terminal.kind === 'agent' ? 'agent' : 'chat',
            title: asString(terminal.title) || 'Terminal',
            status: asString(terminal.status),
            providerId: asString(terminal.providerId),
            activePaneId: asString(terminal.activePaneId),
            paneStates,
            sessionState: sessionStateRaw
              ? {
                  sessionId: asString(sessionStateRaw.sessionId),
                  projectPath: asString(sessionStateRaw.projectPath),
                  initialProjectPath: asString(sessionStateRaw.initialProjectPath),
                  providerId: asString(sessionStateRaw.providerId),
                }
              : undefined,
          };

          return mapped;
        })
        .filter(hasId);

      const mapped: MirrorWorkspace = {
        id: asString(tab.id) || '',
        title: asString(tab.title) || 'Workspace',
        projectPath: asString(tab.projectPath) || '',
        status: asString(tab.status),
        activeTerminalTabId: asNullableString(tab.activeTerminalTabId),
        terminalTabs,
      };

      return mapped;
    })
    .filter(hasId);

  const mirror: MirrorState = {
    tabs,
    activeTabId: asNullableString(state.activeTabId),
    utilityOverlay: asNullableString(state.utilityOverlay),
    activeContext: {
      activeWorkspaceId: null,
      activeTerminalTabId: null,
      activeEmbeddedTerminalId: null,
      activeSessionId: null,
      projectPath: null,
      workspaceCount: tabs.length,
      terminalCount: tabs.reduce((count, tab) => count + tab.terminalTabs.length, 0),
    },
  };

  const activeWorkspace = getActiveWorkspace(mirror);
  const activeTerminal = getActiveTerminal(activeWorkspace);
  const activeEmbeddedTerminalId = getActiveEmbeddedTerminalId(activeTerminal);
  const activeSessionId =
    activeTerminal?.sessionState?.sessionId ||
    Object.values(activeTerminal?.paneStates || {}).find((pane) => pane.sessionId)?.sessionId ||
    null;
  const projectPath =
    activeWorkspace?.projectPath ||
    activeTerminal?.sessionState?.projectPath ||
    activeTerminal?.sessionState?.initialProjectPath ||
    Object.values(activeTerminal?.paneStates || {}).find((pane) => pane.projectPath)?.projectPath ||
    null;

  mirror.activeContext = {
    activeWorkspaceId: activeWorkspace?.id ?? null,
    activeTerminalTabId: activeTerminal?.id ?? null,
    activeEmbeddedTerminalId,
    activeSessionId,
    projectPath,
    workspaceCount: tabs.length,
    terminalCount: tabs.reduce((count, tab) => count + tab.terminalTabs.length, 0),
  };

  return mirror;
}

export function getActiveWorkspace(mirror: MirrorState | null): MirrorWorkspace | null {
  if (!mirror || mirror.tabs.length === 0) return null;

  if (mirror.activeTabId) {
    const active = mirror.tabs.find((tab) => tab.id === mirror.activeTabId);
    if (active) return active;
  }

  return mirror.tabs[0] ?? null;
}

export function getActiveTerminal(workspace: MirrorWorkspace | null): MirrorTerminal | null {
  if (!workspace || workspace.terminalTabs.length === 0) return null;

  if (workspace.activeTerminalTabId) {
    const active = workspace.terminalTabs.find((terminal) => terminal.id === workspace.activeTerminalTabId);
    if (active) return active;
  }

  return workspace.terminalTabs[0] ?? null;
}

export function getActiveEmbeddedTerminalId(terminal: MirrorTerminal | null): string | null {
  if (!terminal) return null;

  if (terminal.activePaneId) {
    const fromActivePane = terminal.paneStates[terminal.activePaneId]?.embeddedTerminalId;
    if (fromActivePane) return fromActivePane;
  }

  for (const paneState of Object.values(terminal.paneStates)) {
    if (paneState.embeddedTerminalId) {
      return paneState.embeddedTerminalId;
    }
  }

  return null;
}

function applyWorkspaceStateChanged(
  mirror: MirrorState | null,
  payload: unknown
): MirrorState | null {
  if (!mirror) return mirror;
  const raw = asObject(payload);
  if (!raw) return mirror;

  const nextActiveTabId =
    typeof raw.activeTabId === 'string' || raw.activeTabId === null
      ? (raw.activeTabId as string | null)
      : mirror.activeTabId;

  const nextUtilityOverlay =
    typeof raw.utilityOverlay === 'string' || raw.utilityOverlay === null
      ? (raw.utilityOverlay as string | null)
      : mirror.utilityOverlay;
  const nextActiveWorkspaceId =
    typeof raw.activeWorkspaceId === 'string' || raw.activeWorkspaceId === null
      ? (raw.activeWorkspaceId as string | null)
      : mirror.activeContext.activeWorkspaceId;
  const nextActiveTerminalTabId =
    typeof raw.activeTerminalTabId === 'string' || raw.activeTerminalTabId === null
      ? (raw.activeTerminalTabId as string | null)
      : mirror.activeContext.activeTerminalTabId;
  const nextActiveEmbeddedTerminalId =
    typeof raw.activeEmbeddedTerminalId === 'string' || raw.activeEmbeddedTerminalId === null
      ? (raw.activeEmbeddedTerminalId as string | null)
      : mirror.activeContext.activeEmbeddedTerminalId;
  const nextActiveSessionId =
    typeof raw.activeSessionId === 'string' || raw.activeSessionId === null
      ? (raw.activeSessionId as string | null)
      : mirror.activeContext.activeSessionId;
  const nextProjectPath =
    typeof raw.projectPath === 'string' || raw.projectPath === null
      ? (raw.projectPath as string | null)
      : mirror.activeContext.projectPath;
  const nextWorkspaceCount =
    typeof raw.workspaceCount === 'number' && Number.isFinite(raw.workspaceCount)
      ? raw.workspaceCount
      : mirror.activeContext.workspaceCount;
  const nextTerminalCount =
    typeof raw.terminalCount === 'number' && Number.isFinite(raw.terminalCount)
      ? raw.terminalCount
      : mirror.activeContext.terminalCount;

  if (
    nextActiveTabId === mirror.activeTabId &&
    nextUtilityOverlay === mirror.utilityOverlay &&
    nextActiveWorkspaceId === mirror.activeContext.activeWorkspaceId &&
    nextActiveTerminalTabId === mirror.activeContext.activeTerminalTabId &&
    nextActiveEmbeddedTerminalId === mirror.activeContext.activeEmbeddedTerminalId &&
    nextActiveSessionId === mirror.activeContext.activeSessionId &&
    nextProjectPath === mirror.activeContext.projectPath &&
    nextWorkspaceCount === mirror.activeContext.workspaceCount &&
    nextTerminalCount === mirror.activeContext.terminalCount
  ) {
    return mirror;
  }

  return {
    ...mirror,
    activeTabId: nextActiveTabId,
    utilityOverlay: nextUtilityOverlay,
    activeContext: {
      ...mirror.activeContext,
      activeWorkspaceId: nextActiveWorkspaceId,
      activeTerminalTabId: nextActiveTerminalTabId,
      activeEmbeddedTerminalId: nextActiveEmbeddedTerminalId,
      activeSessionId: nextActiveSessionId,
      projectPath: nextProjectPath,
      workspaceCount: nextWorkspaceCount,
      terminalCount: nextTerminalCount,
    },
  };
}

function applyTerminalSummaryChanged(
  mirror: MirrorState | null,
  payload: unknown
): MirrorState | null {
  if (!mirror) return mirror;
  const raw = asObject(payload);
  if (!raw) return mirror;

  const activeWorkspaceId =
    typeof raw.activeWorkspaceId === 'string' || raw.activeWorkspaceId === null
      ? (raw.activeWorkspaceId as string | null)
      : mirror.activeContext.activeWorkspaceId;
  const activeTerminalTabId =
    typeof raw.activeTerminalTabId === 'string' || raw.activeTerminalTabId === null
      ? (raw.activeTerminalTabId as string | null)
      : mirror.activeContext.activeTerminalTabId;
  const activeEmbeddedTerminalId =
    typeof raw.activeEmbeddedTerminalId === 'string' || raw.activeEmbeddedTerminalId === null
      ? (raw.activeEmbeddedTerminalId as string | null)
      : mirror.activeContext.activeEmbeddedTerminalId;

  if (
    activeWorkspaceId === mirror.activeContext.activeWorkspaceId &&
    activeTerminalTabId === mirror.activeContext.activeTerminalTabId &&
    activeEmbeddedTerminalId === mirror.activeContext.activeEmbeddedTerminalId
  ) {
    return mirror;
  }

  return {
    ...mirror,
    activeContext: {
      ...mirror.activeContext,
      activeWorkspaceId,
      activeTerminalTabId,
      activeEmbeddedTerminalId,
    },
  };
}

function applyProviderSessionSummaryChanged(
  mirror: MirrorState | null,
  payload: unknown
): MirrorState | null {
  if (!mirror) return mirror;
  const raw = asObject(payload);
  if (!raw) return mirror;

  const activeWorkspaceId =
    typeof raw.activeWorkspaceId === 'string' || raw.activeWorkspaceId === null
      ? (raw.activeWorkspaceId as string | null)
      : mirror.activeContext.activeWorkspaceId;
  const activeTerminalTabId =
    typeof raw.activeTerminalTabId === 'string' || raw.activeTerminalTabId === null
      ? (raw.activeTerminalTabId as string | null)
      : mirror.activeContext.activeTerminalTabId;
  const activeSessionId =
    typeof raw.activeSessionId === 'string' || raw.activeSessionId === null
      ? (raw.activeSessionId as string | null)
      : mirror.activeContext.activeSessionId;
  const projectPath =
    typeof raw.projectPath === 'string' || raw.projectPath === null
      ? (raw.projectPath as string | null)
      : mirror.activeContext.projectPath;

  if (
    activeWorkspaceId === mirror.activeContext.activeWorkspaceId &&
    activeTerminalTabId === mirror.activeContext.activeTerminalTabId &&
    activeSessionId === mirror.activeContext.activeSessionId &&
    projectPath === mirror.activeContext.projectPath
  ) {
    return mirror;
  }

  return {
    ...mirror,
    activeContext: {
      ...mirror.activeContext,
      activeWorkspaceId,
      activeTerminalTabId,
      activeSessionId,
      projectPath,
    },
  };
}

export async function loadStoredCredentials(): Promise<MobileSyncCredentials | null> {
  const raw = await SecureStore.getItemAsync(CREDENTIALS_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<MobileSyncCredentials>;
    if (
      typeof parsed?.deviceId !== 'string' ||
      typeof parsed?.token !== 'string' ||
      typeof parsed?.baseUrl !== 'string' ||
      typeof parsed?.wsUrl !== 'string'
    ) {
      return null;
    }

    return {
      deviceId: parsed.deviceId,
      token: parsed.token,
      baseUrl: parsed.baseUrl,
      wsUrl: parsed.wsUrl,
    };
  } catch {
    return null;
  }
}

export async function persistCredentials(credentials: MobileSyncCredentials): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials));
}

export async function clearStoredCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
}

interface SyncState {
  credentials: MobileSyncCredentials | null;
  snapshot: SnapshotV1 | null;
  mirror: MirrorState | null;
  events: EventEnvelopeV1[];
  lastSequence: number;
  connected: boolean;
  reconnectAttempts: number;
  needsSnapshotRefresh: boolean;
  lastEventType: string | null;
  lastEventAt: string | null;
  lastSnapshotAt: string | null;
  connectionError: string | null;
  setCredentials: (credentials: MobileSyncCredentials | null) => void;
  clearCredentials: () => void;
  setConnected: (connected: boolean) => void;
  setReconnectAttempts: (attempts: number) => void;
  setConnectionError: (error: string | null) => void;
  setSnapshot: (snapshot: SnapshotV1) => void;
  appendEvent: (event: EventEnvelopeV1) => void;
  consumeSnapshotRefreshFlag: () => void;
  resetRuntimeState: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  credentials: null,
  snapshot: null,
  mirror: null,
  events: [],
  lastSequence: 0,
  connected: false,
  reconnectAttempts: 0,
  needsSnapshotRefresh: false,
  lastEventType: null,
  lastEventAt: null,
  lastSnapshotAt: null,
  connectionError: null,
  setCredentials: (credentials) => set({ credentials }),
  clearCredentials: () => set({ credentials: null }),
  setConnected: (connected) => set({ connected }),
  setReconnectAttempts: (reconnectAttempts) => set({ reconnectAttempts }),
  setConnectionError: (connectionError) => set({ connectionError }),
  setSnapshot: (snapshot) =>
    set((state) => ({
      snapshot,
      mirror: deriveMirrorState(snapshot),
      lastSequence: Math.max(state.lastSequence, snapshot.sequence),
      lastSnapshotAt: snapshot.generatedAt,
      needsSnapshotRefresh: false,
    })),
  appendEvent: (event) =>
    set((state) => {
      if (event.sequence <= state.lastSequence) {
        return state;
      }

      const needsSnapshotRefresh =
        event.eventType === 'snapshot.updated' || event.eventType === 'sync.resnapshot_required';

      let nextMirror = state.mirror;
      if (event.eventType === 'workspace.state_changed') {
        nextMirror = applyWorkspaceStateChanged(state.mirror, event.payload);
      } else if (event.eventType === 'terminal.state_summary') {
        nextMirror = applyTerminalSummaryChanged(state.mirror, event.payload);
      } else if (event.eventType === 'provider_session.state_summary') {
        nextMirror = applyProviderSessionSummaryChanged(state.mirror, event.payload);
      }

      return {
        events: [...state.events.slice(-99), event],
        mirror: nextMirror,
        lastSequence: event.sequence,
        lastEventType: event.eventType,
        lastEventAt: event.generatedAt,
        needsSnapshotRefresh: state.needsSnapshotRefresh || needsSnapshotRefresh,
      };
    }),
  consumeSnapshotRefreshFlag: () => set({ needsSnapshotRefresh: false }),
  resetRuntimeState: () =>
    set({
      snapshot: null,
      mirror: null,
      events: [],
      connected: false,
      reconnectAttempts: 0,
      lastSequence: 0,
      lastEventType: null,
      lastEventAt: null,
      lastSnapshotAt: null,
      connectionError: null,
      needsSnapshotRefresh: false,
    }),
}));
