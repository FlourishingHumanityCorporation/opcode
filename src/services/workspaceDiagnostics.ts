import { logger } from '@/lib/logger';

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

export interface StartupLatencySummary {
  samples: number;
  lastMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface StartupLatencyStats extends StartupLatencySummary {
  byProvider: Record<string, StartupLatencySummary>;
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
      logger.error('misc', '[workspaceDiagnostics] listener failed', { error: error });
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

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index];
}

function summarizeLatencies(values: number[]): StartupLatencySummary {
  if (values.length === 0) {
    return {
      samples: 0,
      lastMs: null,
      minMs: null,
      maxMs: null,
      p50Ms: null,
      p95Ms: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    lastMs: values[values.length - 1],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function readLatencyFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  const firstTokenLatencyMs = candidate.firstTokenLatencyMs;
  if (typeof firstTokenLatencyMs === 'number' && Number.isFinite(firstTokenLatencyMs) && firstTokenLatencyMs >= 0) {
    return firstTokenLatencyMs;
  }
  // Backward compatibility with earlier diagnostics payload name.
  const legacyLatencyMs = candidate.latencyMs;
  if (typeof legacyLatencyMs === 'number' && Number.isFinite(legacyLatencyMs) && legacyLatencyMs >= 0) {
    return legacyLatencyMs;
  }
  return null;
}

function readProviderIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return 'unknown';
  }
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.providerId === 'string' && candidate.providerId.trim().length > 0
    ? candidate.providerId
    : 'unknown';
}

export function getStartupLatencyStats(snapshot = getWorkspaceDiagnosticsSnapshot()): StartupLatencyStats {
  const overallLatencies: number[] = [];
  const byProvider = new Map<string, number[]>();

  snapshot.events.forEach((entry) => {
    if (entry.category !== 'stream_watchdog' || entry.action !== 'first_stream_message') {
      return;
    }
    const latencyMs = readLatencyFromPayload(entry.payload);
    if (latencyMs === null) {
      return;
    }

    overallLatencies.push(latencyMs);
    const providerId = readProviderIdFromPayload(entry.payload);
    const current = byProvider.get(providerId) || [];
    current.push(latencyMs);
    byProvider.set(providerId, current);
  });

  const summary = summarizeLatencies(overallLatencies);
  const providerSummary: Record<string, StartupLatencySummary> = {};
  byProvider.forEach((values, providerId) => {
    providerSummary[providerId] = summarizeLatencies(values);
  });

  return {
    ...summary,
    byProvider: providerSummary,
  };
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
