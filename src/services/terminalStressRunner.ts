import { api } from "@/lib/api";
import type { Tab } from "@/contexts/TabContext";
import {
  captureAndPersistIncidentBundle,
  type TerminalIncidentContext,
} from "@/services/terminalHangDiagnostics";

interface TerminalStressState {
  tabs: Tab[];
  activeTabId: string | null;
}

export interface TerminalStressRunnerOptions {
  durationMs?: number;
  intervalMs?: number;
  getState: () => TerminalStressState;
  switchWorkspace: (workspaceId: string) => void;
  switchTerminal: (workspaceId: string, terminalId: string) => void;
  activatePane: (workspaceId: string, terminalId: string, paneId: string) => void;
  onIncidentCaptured?: (path: string, context: TerminalIncidentContext) => void;
}

export interface TerminalStressResult {
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  iterations: number;
  incidents: Array<{ path: string; reason: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextIndex(length: number, current: number): number {
  if (length <= 1) {
    return 0;
  }
  return (current + 1) % length;
}

export async function runTerminalStressTest(
  options: TerminalStressRunnerOptions
): Promise<TerminalStressResult> {
  const durationMs = options.durationMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 350;
  const startedAtMs = Date.now();
  const incidents: Array<{ path: string; reason: string }> = [];
  let iterations = 0;
  let workspaceIndex = 0;
  let terminalIndex = 0;
  let paneIndex = 0;

  while (Date.now() - startedAtMs < durationMs) {
    const state = options.getState();
    const workspaces = state.tabs;
    if (workspaces.length === 0) {
      await sleep(intervalMs);
      continue;
    }

    workspaceIndex = nextIndex(workspaces.length, workspaceIndex);
    const workspace = workspaces[workspaceIndex];
    options.switchWorkspace(workspace.id);

    const terminals = workspace.terminalTabs;
    if (terminals.length === 0) {
      await sleep(intervalMs);
      continue;
    }

    terminalIndex = nextIndex(terminals.length, terminalIndex);
    const terminal = terminals[terminalIndex];
    options.switchTerminal(workspace.id, terminal.id);

    const paneIds = Object.keys(terminal.paneStates || {});
    if (paneIds.length > 0) {
      paneIndex = nextIndex(paneIds.length, paneIndex);
      const paneId = paneIds[paneIndex];
      options.activatePane(workspace.id, terminal.id, paneId);

      const embeddedTerminalId = terminal.paneStates[paneId]?.embeddedTerminalId;
      if (embeddedTerminalId) {
        try {
          await api.writeEmbeddedTerminalInput(embeddedTerminalId, "echo opcode-health\n");
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const context: TerminalIncidentContext = {
            workspaceId: workspace.id,
            terminalId: terminal.id,
            paneId,
            embeddedTerminalId,
            tabs: state.tabs,
            activeTabId: state.activeTabId,
            note: `Stress test write failed: ${reason}`,
          };
          const incident = await captureAndPersistIncidentBundle(context);
          incidents.push({ path: incident.path, reason });
          options.onIncidentCaptured?.(incident.path, context);
        }
      }
    }

    iterations += 1;
    await sleep(intervalMs);
  }

  const endedAtMs = Date.now();
  return {
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
    iterations,
    incidents,
  };
}
