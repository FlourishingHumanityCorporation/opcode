import { describe, expect, it } from "vitest";
import type { Tab, TerminalTab } from "@/contexts/TabContext";
import {
  getWorkspaceAggregateStatus,
  getWorkspaceStatusMeta,
} from "@/components/TabManager";

function makeTerminal(
  id: string,
  status: TerminalTab["status"]
): TerminalTab {
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
    status,
    hasUnsavedChanges: false,
    createdAt: now,
    updatedAt: now,
  };
}

function makeWorkspace(terminalStatuses: TerminalTab["status"][]): Tab {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const terminals = terminalStatuses.map((status, index) =>
    makeTerminal(`terminal-${index}`, status)
  );

  return {
    id: "workspace-1",
    type: "project",
    projectPath: "/tmp/project",
    title: "Project",
    activeTerminalTabId: terminals[0]?.id ?? null,
    terminalTabs: terminals,
    status: "idle",
    hasUnsavedChanges: false,
    order: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("TabManager workspace status aggregation", () => {
  it("prioritizes attention over other states", () => {
    const workspace = makeWorkspace(["complete", "attention", "running"]);
    expect(getWorkspaceAggregateStatus(workspace)).toBe("attention");
  });

  it("falls back by priority: error > running > complete", () => {
    expect(getWorkspaceAggregateStatus(makeWorkspace(["running", "complete"]))).toBe(
      "running"
    );
    expect(getWorkspaceAggregateStatus(makeWorkspace(["error", "running"]))).toBe(
      "error"
    );
    expect(getWorkspaceAggregateStatus(makeWorkspace(["complete", "idle"]))).toBe(
      "complete"
    );
  });

  it("maps workspace status metadata for indicator rendering", () => {
    expect(getWorkspaceStatusMeta("attention")).toEqual({
      kind: "needs_response",
      label: "Needs response",
    });
    expect(getWorkspaceStatusMeta("running")).toEqual({
      kind: "running",
      label: "In progress",
    });
    expect(getWorkspaceStatusMeta("complete")).toEqual({
      kind: "needs_check",
      label: "Needs check",
    });
    expect(getWorkspaceStatusMeta("error")).toEqual({
      kind: "error",
      label: "Error",
    });
    expect(getWorkspaceStatusMeta("idle")).toBeNull();
  });
});
