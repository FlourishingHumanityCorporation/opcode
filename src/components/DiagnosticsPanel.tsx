import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Copy, Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTabContext } from '@/contexts/TabContext';
import { api, type SessionStartupProbeResult } from '@/lib/api';
import { TabPersistenceService } from '@/services/tabPersistence';
import {
  clearWorkspaceDiagnostics,
  exportWorkspaceDiagnostics,
  getStartupLatencyStats,
  getWorkspaceDiagnosticsSnapshot,
  logWorkspaceEvent,
  subscribeWorkspaceDiagnostics,
  type WorkspaceDiagnosticEvent,
} from '@/services/workspaceDiagnostics';

type DiagnosticEntry = WorkspaceDiagnosticEvent & { id: number; timestamp: string };

export const DiagnosticsPanel: React.FC = () => {
  const { tabs, activeTabId } = useTabContext();
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<SessionStartupProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const refresh = () => {
    const snapshot = getWorkspaceDiagnosticsSnapshot();
    setEntries(snapshot.events);
  };

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeWorkspaceDiagnostics(refresh);
    return unsubscribe;
  }, []);

  const storageInspection = useMemo(() => TabPersistenceService.inspectStoredWorkspace(), [entries]);
  const startupLatency = useMemo(() => getStartupLatencyStats(), [entries]);
  const activeWorkspace = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  );
  const probeProjectPath = useMemo(() => {
    if (!activeWorkspace) return '';
    const activeTerminal =
      activeWorkspace.terminalTabs.find((terminal) => terminal.id === activeWorkspace.activeTerminalTabId) ??
      activeWorkspace.terminalTabs[0];
    const activePaneState = activeTerminal ? activeTerminal.paneStates[activeTerminal.activePaneId] : undefined;
    return (
      activeWorkspace.projectPath ||
      activeTerminal?.sessionState?.projectPath ||
      activeTerminal?.sessionState?.initialProjectPath ||
      activePaneState?.projectPath ||
      ''
    );
  }, [activeWorkspace]);

  const handleCopy = async () => {
    const output = exportWorkspaceDiagnostics();
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const handleDownload = () => {
    const output = exportWorkspaceDiagnostics();
    const blob = new Blob([output], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `workspace-diagnostics-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const runProbe = async (kind: 'startup' | 'assistant') => {
    if (!probeProjectPath) {
      setProbeError('No project path available in the active workspace.');
      return;
    }

    setIsProbing(true);
    setProbeError(null);
    setProbeResult(null);
    logWorkspaceEvent({
      category: 'stream_watchdog',
      action: 'startup_probe_started',
      payload: { projectPath: probeProjectPath, benchmarkKind: kind },
    });

    try {
      const result = await api.runSessionStartupProbe(probeProjectPath, {
        model: 'sonnet',
        timeoutMs: 45_000,
        benchmarkKind: kind,
      });
      setProbeResult(result);
      logWorkspaceEvent({
        category: 'stream_watchdog',
        action: 'startup_probe_completed',
        payload: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Probe failed';
      setProbeError(message);
      logWorkspaceEvent({
        category: 'error',
        action: 'startup_probe_failed',
        message,
        payload: { projectPath: probeProjectPath, benchmarkKind: kind },
      });
    } finally {
      setIsProbing(false);
    }
  };

  const handleRunStartupProbe = () => runProbe('startup');
  const handleRunAssistantBenchmark = () => runProbe('assistant');

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Workspace Diagnostics</h3>
          <p className="text-xs text-muted-foreground">
            {entries.length} events in memory
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRunStartupProbe}
            disabled={isProbing || !probeProjectPath}
            title={probeProjectPath || 'No project path available'}
          >
            <Activity className={`mr-1.5 h-4 w-4 ${isProbing ? 'animate-spin' : ''}`} />
            {isProbing ? 'Probing...' : 'Run Startup Probe'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRunAssistantBenchmark}
            disabled={isProbing || !probeProjectPath}
            title={probeProjectPath || 'No project path available'}
          >
            <Activity className={`mr-1.5 h-4 w-4 ${isProbing ? 'animate-spin' : ''}`} />
            {isProbing ? 'Probing...' : 'Run Assistant Benchmark'}
          </Button>
          <Button size="icon" variant="ghost" onClick={refresh} title="Refresh diagnostics">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={handleCopy} title="Copy diagnostics JSON">
            <Copy className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={handleDownload} title="Download diagnostics JSON">
            <Download className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              clearWorkspaceDiagnostics();
              refresh();
            }}
            title="Clear diagnostics"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {copied && (
        <div className="border-b border-border/60 bg-primary/10 px-4 py-2 text-xs text-primary">
          Diagnostics copied to clipboard
        </div>
      )}

      {(probeResult || probeError) && (
        <div className="border-b border-border/60 px-4 py-3 text-xs">
          <div className="mb-1 font-medium">Latest Probe</div>
          {probeError ? (
            <div className="text-destructive">{probeError}</div>
          ) : probeResult ? (
            <div className="text-muted-foreground">
              mode={probeResult.benchmark_kind} | firstAssistant={probeResult.first_assistant_message_ms ?? '-'}ms |
              firstByte={probeResult.first_byte_ms ?? '-'}ms | total={probeResult.total_ms}ms | exit=
              {probeResult.exit_code ?? 'null'} | timeout={probeResult.timed_out ? 'yes' : 'no'} | bytes(out/err)=
              {probeResult.stdout_bytes}/{probeResult.stderr_bytes}
            </div>
          ) : null}
        </div>
      )}

      <div className="border-b border-border/60 px-4 py-3 text-xs">
        <div className="mb-1 font-medium">Session Startup Latency</div>
        <div className="text-muted-foreground">
          samples={startupLatency.samples} | last={startupLatency.lastMs ?? '-'}ms | p50={startupLatency.p50Ms ?? '-'}ms | p95={startupLatency.p95Ms ?? '-'}ms
        </div>
        <div className="text-muted-foreground">
          {Object.entries(startupLatency.byProvider)
            .map(([providerId, stats]) => `${providerId}: n=${stats.samples}, p50=${stats.p50Ms ?? '-'}ms, p95=${stats.p95Ms ?? '-'}ms`)
            .join(' | ') || 'by-provider=none'}
        </div>
      </div>

      <div className="border-b border-border/60 px-4 py-3 text-xs">
        <div className="mb-1 font-medium">Workspace Snapshot</div>
        <div className="text-muted-foreground">
          stored={storageInspection.found ? 'yes' : 'no'} | tabs={storageInspection.tabCount} | terminals={storageInspection.terminalCount} | active={storageInspection.activeTabId || 'none'}
        </div>
        <div className="text-muted-foreground">probeProject={probeProjectPath || 'none'}</div>
        <div className={storageInspection.validation.valid ? 'text-emerald-500' : 'text-destructive'}>
          invariants={storageInspection.validation.valid ? 'ok' : storageInspection.validation.errors.join(' | ')}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <div className="text-xs text-muted-foreground">No diagnostics captured yet.</div>
        ) : (
          <div className="space-y-2">
            {[...entries].reverse().map((entry) => (
              <div key={entry.id} className="rounded-md border border-border/60 p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{entry.category}</span>
                  <span className="text-muted-foreground">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="mt-1">{entry.action}</div>
                {entry.message && <div className="mt-1 text-destructive">{entry.message}</div>}
                <div className="mt-1 text-muted-foreground">
                  tabs={entry.tabCount ?? '-'} | terminals={entry.terminalCount ?? '-'} | ws={entry.activeWorkspaceId ?? '-'}
                </div>
                {entry.workspaceHash && (
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{entry.workspaceHash}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DiagnosticsPanel;
