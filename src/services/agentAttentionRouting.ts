import type { Tab, TerminalTab } from "@/contexts/TabContext";
import type { AgentAttentionEventDetail } from "@/services/agentAttention";

export function mapAgentAttentionKindToStatus(
  kind: AgentAttentionEventDetail["kind"]
): TerminalTab["status"] {
  return kind === "needs_input" ? "attention" : "complete";
}

function findTerminalWorkspace(
  tabs: Tab[],
  terminalTabId: string
): Tab | undefined {
  return tabs.find((workspace) =>
    workspace.terminalTabs.some((terminal) => terminal.id === terminalTabId)
  );
}

export function applyAgentAttentionStatusUpdate(
  tabs: Tab[],
  updateTab: (id: string, updates: Partial<Tab> | Partial<TerminalTab>) => void,
  detail: AgentAttentionEventDetail
): boolean {
  if (!detail.terminalTabId) {
    return false;
  }

  const workspaceForTerminal = findTerminalWorkspace(tabs, detail.terminalTabId);
  if (!workspaceForTerminal) {
    return false;
  }

  updateTab(detail.terminalTabId, {
    status: mapAgentAttentionKindToStatus(detail.kind),
  });
  return true;
}
