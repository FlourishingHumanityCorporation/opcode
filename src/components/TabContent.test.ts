import { describe, expect, it, vi } from "vitest";
import type { Tab, TerminalTab } from "@/contexts/TabContext";
import {
  applyAgentAttentionStatusUpdate,
  mapAgentAttentionKindToStatus,
  normalizeAgentAttentionSource,
} from "@/components/TabContent";
import type { AgentAttentionEventDetail } from "@/services/agentAttention";

function makeTerminal(id: string): TerminalTab {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const paneId = `${id}-pane`;
  return {
    id,
    kind: "chat",
    title: id,
    providerId: "claude",
    sessionState: {
      providerId: "claude",
      projectPath: "/tmp/project",
      initialProjectPath: "/tmp/project",
    },
    paneTree: {
      id: paneId,
      type: "leaf",
      leafSessionId: paneId,
    },
    activePaneId: paneId,
    paneStates: {},
    status: "idle",
    hasUnsavedChanges: false,
    createdAt: now,
    updatedAt: now,
  };
}

function makeWorkspace(terminalId: string): Tab {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const terminal = makeTerminal(terminalId);
  return {
    id: "workspace-1",
    type: "project",
    projectPath: "/tmp/project",
    title: "Project",
    activeTerminalTabId: terminal.id,
    terminalTabs: [terminal],
    status: "idle",
    hasUnsavedChanges: false,
    order: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("TabContent agent attention event handling", () => {
  it("maps attention kinds to terminal statuses", () => {
    expect(mapAgentAttentionKindToStatus("done")).toBe("complete");
    expect(mapAgentAttentionKindToStatus("needs_input")).toBe("attention");
  });

  it("applies done events to terminal status", () => {
    const updateTab = vi.fn();
    const detail: AgentAttentionEventDetail = {
      kind: "done",
      workspaceId: "workspace-1",
      terminalTabId: "terminal-1",
      title: "Agent done",
      body: "Finished.",
      source: "provider_session",
      sourceV2: "provider_session",
      timestamp: Date.now(),
    };

    const applied = applyAgentAttentionStatusUpdate(
      [makeWorkspace("terminal-1")],
      updateTab,
      detail
    );

    expect(applied).toBe(true);
    expect(updateTab).toHaveBeenCalledWith("terminal-1", { status: "complete" });
  });

  it("applies needs_input events to terminal status", () => {
    const updateTab = vi.fn();
    const detail: AgentAttentionEventDetail = {
      kind: "needs_input",
      workspaceId: "workspace-1",
      terminalTabId: "terminal-1",
      title: "Agent needs input",
      body: "Please approve.",
      source: "agent_execution",
      sourceV2: "agent_execution",
      timestamp: Date.now(),
    };

    const applied = applyAgentAttentionStatusUpdate(
      [makeWorkspace("terminal-1")],
      updateTab,
      detail
    );

    expect(applied).toBe(true);
    expect(updateTab).toHaveBeenCalledWith("terminal-1", { status: "attention" });
  });

  it("ignores events when terminal id is missing", () => {
    const updateTab = vi.fn();
    const detail: AgentAttentionEventDetail = {
      kind: "done",
      workspaceId: "workspace-1",
      title: "Agent done",
      body: "Finished.",
      source: "agent_execution",
      sourceV2: "agent_execution",
      timestamp: Date.now(),
    };

    const applied = applyAgentAttentionStatusUpdate(
      [makeWorkspace("terminal-1")],
      updateTab,
      detail
    );

    expect(applied).toBe(false);
    expect(updateTab).not.toHaveBeenCalled();
  });

  it("normalizes legacy claude_session source to provider_session", () => {
    const detail: AgentAttentionEventDetail = {
      kind: "done",
      workspaceId: "workspace-1",
      terminalTabId: "terminal-1",
      title: "Agent done",
      body: "Finished.",
      source: "claude_session",
      sourceV2: "provider_session",
      timestamp: Date.now(),
    };

    expect(normalizeAgentAttentionSource(detail)).toBe("provider_session");
  });
});
