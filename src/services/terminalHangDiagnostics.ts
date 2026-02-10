import { api, type EmbeddedTerminalDebugSnapshot } from "@/lib/api";
import { getEnvironmentInfo } from "@/lib/apiAdapter";
import type { Tab } from "@/contexts/TabContext";

const TERMINAL_DEBUG_STORAGE_KEY = "codeinterfacex.terminal.debug";
const MAX_TERMINAL_EVENTS = 400;
const DEAD_INPUT_CAPTURE_WINDOW_MS = 60_000;
let workspaceSnapshotProvider:
  | (() => { tabs: Tab[]; activeTabId: string | null })
  | null = null;

export interface TerminalHangEvent {
  ts: number;
  workspaceId?: string;
  terminalId?: string;
  paneId?: string;
  embeddedTerminalId?: string;
  event: string;
  payload?: Record<string, unknown>;
}

export interface TerminalWorkspaceSummary {
  activeTabId: string | null;
  workspaceCount: number;
  terminalCount: number;
  paneCount: number;
  workspaces: Array<{
    workspaceId: string;
    activeTerminalTabId: string | null;
    terminalCount: number;
    terminals: Array<{
      terminalId: string;
      activePaneId: string;
      paneIds: string[];
      embeddedTerminalIds: string[];
    }>;
  }>;
}

export interface TerminalIncidentBundle {
  version: 1;
  capturedAtMs: number;
  note?: string;
  context: {
    workspaceId?: string;
    terminalId?: string;
    paneId?: string;
    embeddedTerminalId?: string;
  };
  classification: string;
  frontendEvents: TerminalHangEvent[];
  backendSnapshot?: EmbeddedTerminalDebugSnapshot;
  workspaceSummary?: TerminalWorkspaceSummary;
  environment: Record<string, unknown>;
}

export interface TerminalIncidentContext {
  workspaceId?: string;
  terminalId?: string;
  paneId?: string;
  embeddedTerminalId?: string;
  note?: string;
  tabs?: Tab[];
  activeTabId?: string | null;
  environment?: Record<string, unknown>;
}

const terminalEvents: TerminalHangEvent[] = [];
const deadInputCaptureByPane = new Map<string, number>();

function hasLocalStorageDebugFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem(TERMINAL_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isTerminalHangDebugEnabled(): boolean {
  return Boolean((globalThis as any).__CODEINTERFACEX_DEBUG_LOGS__) || hasLocalStorageDebugFlag();
}

export function recordTerminalEvent(event: Omit<TerminalHangEvent, "ts">): void {
  terminalEvents.push({
    ts: Date.now(),
    ...event,
  });
  if (terminalEvents.length > MAX_TERMINAL_EVENTS) {
    terminalEvents.splice(0, terminalEvents.length - MAX_TERMINAL_EVENTS);
  }
}

export function getTerminalEventSnapshot(): TerminalHangEvent[] {
  return terminalEvents.map((entry) => ({ ...entry }));
}

export function clearTerminalEventSnapshot(): void {
  terminalEvents.length = 0;
}

export function setTerminalWorkspaceSnapshotProvider(
  provider: (() => { tabs: Tab[]; activeTabId: string | null }) | null
): void {
  workspaceSnapshotProvider = provider;
}

export function shouldCaptureDeadInputIncident(
  paneKey: string,
  nowMs = Date.now()
): boolean {
  const lastCapturedAt = deadInputCaptureByPane.get(paneKey) ?? 0;
  if (nowMs - lastCapturedAt < DEAD_INPUT_CAPTURE_WINDOW_MS) {
    return false;
  }
  deadInputCaptureByPane.set(paneKey, nowMs);
  return true;
}

export function buildWorkspaceSummary(
  tabs: Tab[] = [],
  activeTabId: string | null = null
): TerminalWorkspaceSummary {
  const workspaces = tabs.map((workspace) => ({
    workspaceId: workspace.id,
    activeTerminalTabId: workspace.activeTerminalTabId,
    terminalCount: workspace.terminalTabs.length,
    terminals: workspace.terminalTabs.map((terminal) => {
      const paneIds = Object.keys(terminal.paneStates || {});
      const embeddedTerminalIds = paneIds
        .map((paneId) => terminal.paneStates[paneId]?.embeddedTerminalId)
        .filter((id): id is string => Boolean(id));

      return {
        terminalId: terminal.id,
        activePaneId: terminal.activePaneId,
        paneIds,
        embeddedTerminalIds,
      };
    }),
  }));

  return {
    activeTabId,
    workspaceCount: tabs.length,
    terminalCount: workspaces.reduce((total, workspace) => total + workspace.terminalCount, 0),
    paneCount: workspaces.reduce(
      (total, workspace) =>
        total +
        workspace.terminals.reduce((terminalTotal, terminal) => terminalTotal + terminal.paneIds.length, 0),
      0
    ),
    workspaces,
  };
}

export function classifyIncidentBundle(
  bundle: Pick<TerminalIncidentBundle, "frontendEvents" | "backendSnapshot">
): string {
  const events = bundle.frontendEvents;
  const backendSessions = bundle.backendSnapshot?.sessions || [];

  if (events.some((event) => event.payload?.errorCode === "ERR_SESSION_NOT_FOUND")) {
    return "stale_frontend_terminal_id";
  }
  if (backendSessions.some((session) => !session.alive)) {
    return "dead_pty_child";
  }
  if (events.some((event) => event.event === "listener_attach_failed")) {
    return "detached_listener_path";
  }
  if (
    events.some(
      (event) =>
        event.event === "stdin_disabled" ||
        event.event === "focus_handoff_blocked" ||
        event.event === "focus_retry_cancelled"
    )
  ) {
    return "interactive_focus_gating";
  }
  if (events.some((event) => event.event === "stale_recovery_escalated")) {
    return "stale_recovery_escalated";
  }
  if (events.some((event) => event.event === "soft_reattach_trigger")) {
    return "terminal_soft_reattach";
  }
  if (events.some((event) => event.payload?.errorCode === "ERR_WRITE_FAILED")) {
    return "backend_write_stall";
  }
  if (events.some((event) => event.event === "wheel_observed")) {
    return "wheel_input_observed";
  }
  return "unclassified_terminal_hang";
}

export function buildTerminalIncidentBundle(
  context: TerminalIncidentContext,
  backendSnapshot?: EmbeddedTerminalDebugSnapshot
): TerminalIncidentBundle {
  const frontendEvents = getTerminalEventSnapshot();
  const workspaceSnapshot = context.tabs
    ? { tabs: context.tabs, activeTabId: context.activeTabId ?? null }
    : workspaceSnapshotProvider?.();
  const workspaceSummary = workspaceSnapshot
    ? buildWorkspaceSummary(workspaceSnapshot.tabs, workspaceSnapshot.activeTabId)
    : undefined;

  const bundleBase: Omit<TerminalIncidentBundle, "classification"> = {
    version: 1,
    capturedAtMs: Date.now(),
    note: context.note,
    context: {
      workspaceId: context.workspaceId,
      terminalId: context.terminalId,
      paneId: context.paneId,
      embeddedTerminalId: context.embeddedTerminalId,
    },
    frontendEvents,
    backendSnapshot,
    workspaceSummary,
    environment: context.environment ?? getEnvironmentInfo(),
  };

  return {
    ...bundleBase,
    classification: classifyIncidentBundle(bundleBase),
  };
}

export async function collectIncidentBundle(
  context: TerminalIncidentContext
): Promise<TerminalIncidentBundle> {
  let backendSnapshot: EmbeddedTerminalDebugSnapshot | undefined;
  try {
    backendSnapshot = await api.getEmbeddedTerminalDebugSnapshot();
  } catch (error) {
    recordTerminalEvent({
      workspaceId: context.workspaceId,
      terminalId: context.terminalId,
      paneId: context.paneId,
      embeddedTerminalId: context.embeddedTerminalId,
      event: "backend_snapshot_failed",
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  return buildTerminalIncidentBundle(context, backendSnapshot);
}

export async function captureAndPersistIncidentBundle(
  context: TerminalIncidentContext
): Promise<{ path: string; bundle: TerminalIncidentBundle }> {
  const bundle = await collectIncidentBundle(context);
  const path = await api.writeTerminalIncidentBundle(bundle, context.note);
  return { path, bundle };
}
