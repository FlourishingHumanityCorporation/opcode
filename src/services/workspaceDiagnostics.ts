export type WorkspaceDiagnosticCategory =
  | 'state_action'
  | 'reorder'
  | 'persist_save'
  | 'persist_load'
  | 'persist_migration'
  | 'stream_watchdog'
  | 'preflight'
  | 'error';

export interface WorkspaceDiagnosticEvent {
  category: WorkspaceDiagnosticCategory;
  action: string;
  message?: string;
  workspaceHash?: string;
  activeWorkspaceId?: string | null;
  activeTerminalId?: string | null;
  tabCount?: number;
  terminalCount?: number;
  payload?: unknown;
}

export interface WorkspaceDiagnosticsSnapshot {
  count: number;
  events: Array<WorkspaceDiagnosticEvent & { id: number; timestamp: string }>;
}

const MAX_EVENTS = 500;
let sequence = 0;
let events: Array<WorkspaceDiagnosticEvent & { id: number; timestamp: string }> = [];
const listeners = new Set<() => void>();

function emitUpdate(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[workspaceDiagnostics] listener failed', error);
    }
  });
}

export function subscribeWorkspaceDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function logWorkspaceEvent(event: WorkspaceDiagnosticEvent): void {
  const entry = {
    ...event,
    id: ++sequence,
    timestamp: new Date().toISOString(),
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) {
    events = events.slice(events.length - MAX_EVENTS);
  }
  emitUpdate();
}

export function getWorkspaceDiagnosticsSnapshot(): WorkspaceDiagnosticsSnapshot {
  return {
    count: events.length,
    events: [...events],
  };
}

export function clearWorkspaceDiagnostics(): void {
  events = [];
  emitUpdate();
}

export function exportWorkspaceDiagnostics(): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: events.length,
      events,
    },
    null,
    2
  );
}

export function hashWorkspaceState(input: unknown): string {
  try {
    const raw = JSON.stringify(input);
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `ws_${(hash >>> 0).toString(16).padStart(8, '0')}`;
  } catch {
    return 'ws_unknown';
  }
}
