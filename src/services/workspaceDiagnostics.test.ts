import { describe, expect, it } from 'vitest';
import {
  clearWorkspaceDiagnostics,
  getStartupLatencyStats,
  logWorkspaceEvent,
} from '@/services/workspaceDiagnostics';

describe('workspaceDiagnostics startup latency stats', () => {
  it('returns empty stats when no first-stream samples exist', () => {
    clearWorkspaceDiagnostics();
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'prompt_started',
      payload: { providerId: 'claude' },
    });

    const stats = getStartupLatencyStats();
    expect(stats.samples).toBe(0);
    expect(stats.lastMs).toBeNull();
    expect(stats.p50Ms).toBeNull();
    expect(stats.p95Ms).toBeNull();
    expect(Object.keys(stats.byProvider)).toHaveLength(0);
  });

  it('computes overall and per-provider startup latency summaries', () => {
    clearWorkspaceDiagnostics();
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId: 'claude', firstTokenLatencyMs: 100 },
    });
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId: 'codex', firstTokenLatencyMs: 200 },
    });
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId: 'claude', firstTokenLatencyMs: 300 },
    });
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId: 'codex', firstTokenLatencyMs: 400 },
    });
    // Legacy payload support
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'first_stream_message',
      payload: { providerId: 'claude', latencyMs: 500 },
    });

    const stats = getStartupLatencyStats();
    expect(stats.samples).toBe(5);
    expect(stats.lastMs).toBe(500);
    expect(stats.minMs).toBe(100);
    expect(stats.maxMs).toBe(500);
    expect(stats.p50Ms).toBe(300);
    expect(stats.p95Ms).toBe(500);

    expect(stats.byProvider.claude.samples).toBe(3);
    expect(stats.byProvider.claude.lastMs).toBe(500);
    expect(stats.byProvider.claude.p50Ms).toBe(300);
    expect(stats.byProvider.codex.samples).toBe(2);
    expect(stats.byProvider.codex.lastMs).toBe(400);
    expect(stats.byProvider.codex.p95Ms).toBe(400);
  });
});
