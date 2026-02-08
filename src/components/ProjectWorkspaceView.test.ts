import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/WorkspacePaneTree", () => ({
  WorkspacePaneTree: () => null,
}));

vi.mock("@/components/ProjectExplorerPanel", () => ({
  ProjectExplorerPanel: () => null,
}));

vi.mock("@/components/ui/split-pane", () => ({
  SplitPane: ({ right }: { right?: unknown }) => right ?? null,
}));

import type { TerminalTab } from "@/contexts/TabContext";
import {
  getTerminalStatusMeta,
  persistExplorerSplitWidth,
  resolveTerminalStatusOnActivate,
  toggleExplorerPanel,
  toggleTerminalTitleLock,
} from "@/components/ProjectWorkspaceView";
import * as explorerPreferences from "@/lib/projectExplorerPreferences";

function makeTerminal(overrides: Partial<TerminalTab> = {}): TerminalTab {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const paneId = "pane-1";
  return {
    id: "terminal-1",
    kind: "chat",
    title: "Terminal 1",
    titleLocked: false,
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
    ...overrides,
  };
}

describe("ProjectWorkspaceView title lock", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("toggles terminal title lock state via updateTab", () => {
    const updateTab = vi.fn();
    const terminal = makeTerminal({ titleLocked: false });

    toggleTerminalTitleLock(updateTab, terminal);
    expect(updateTab).toHaveBeenCalledWith("terminal-1", { titleLocked: true });

    const lockedTerminal = makeTerminal({ titleLocked: true });
    toggleTerminalTitleLock(updateTab, lockedTerminal);
    expect(updateTab).toHaveBeenLastCalledWith("terminal-1", { titleLocked: false });
  });

  it("maps terminal statuses to indicator metadata", () => {
    expect(getTerminalStatusMeta("running")).toEqual({
      label: "Running",
      className: "bg-emerald-500",
    });
    expect(getTerminalStatusMeta("complete")).toEqual({
      label: "Complete",
      className: "bg-sky-500",
    });
    expect(getTerminalStatusMeta("attention")).toEqual({
      label: "Needs input",
      className: "bg-amber-500",
    });
    expect(getTerminalStatusMeta("error")).toEqual({
      label: "Error",
      className: "bg-rose-500",
    });
    expect(getTerminalStatusMeta("idle")).toBeNull();
    expect(getTerminalStatusMeta("active")).toBeNull();
  });

  it("clears complete and attention statuses when terminal becomes active", () => {
    expect(resolveTerminalStatusOnActivate("complete")).toBe("idle");
    expect(resolveTerminalStatusOnActivate("attention")).toBe("idle");
    expect(resolveTerminalStatusOnActivate("running")).toBe("running");
    expect(resolveTerminalStatusOnActivate("error")).toBe("error");
  });

  it("toggles explorer panel open state transitions", () => {
    expect(toggleExplorerPanel(true)).toBe(false);
    expect(toggleExplorerPanel(false)).toBe(true);
  });

  it("persists explorer split width through preferences helper", () => {
    const setExplorerWidthSpy = vi.spyOn(explorerPreferences, "setExplorerWidth");

    const persisted = persistExplorerSplitWidth("workspace-42", 31.5);

    expect(persisted).toBe(31.5);
    expect(setExplorerWidthSpy).toHaveBeenCalledWith("workspace-42", 31.5);
  });
});
