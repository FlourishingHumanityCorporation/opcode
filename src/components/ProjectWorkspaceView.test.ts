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
  resolveProjectSwitchForActiveTerminal,
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
      kind: "running",
      label: "In progress",
    });
    expect(getTerminalStatusMeta("complete")).toEqual({
      kind: "needs_check",
      label: "Needs check",
    });
    expect(getTerminalStatusMeta("attention")).toEqual({
      kind: "needs_response",
      label: "Needs response",
    });
    expect(getTerminalStatusMeta("error")).toEqual({
      kind: "error",
      label: "Error",
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

  it("resets pane and terminal session linkage when switching projects", () => {
    const terminal = makeTerminal({
      sessionState: {
        providerId: "claude",
        sessionId: "session-123",
        sessionData: { id: "session-123" },
        projectPath: "/tmp/project-a",
        initialProjectPath: "/tmp/project-a",
      },
      paneStates: {
        "pane-1": {
          projectPath: "/tmp/project-a",
          sessionId: "session-123",
          embeddedTerminalId: "term-abc",
          restorePreference: "resume_latest",
        },
      },
    });
    const workspace = {
      id: "workspace-1",
      type: "project" as const,
      projectPath: "/tmp/project-a",
      title: "Project A",
      activeTerminalTabId: terminal.id,
      terminalTabs: [terminal],
      status: "idle" as const,
      hasUnsavedChanges: false,
      order: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const resolved = resolveProjectSwitchForActiveTerminal(workspace, terminal, "/tmp/project-b");

    expect(resolved.didProjectSwitch).toBe(true);
    expect(resolved.nextCanonicalPath).toBe("/tmp/project-b");
    expect(resolved.embeddedTerminalIdToClose).toBe("term-abc");
    expect(resolved.nextPaneState).toEqual({
      projectPath: "/tmp/project-b",
      embeddedTerminalId: undefined,
      sessionId: undefined,
      restorePreference: "start_fresh",
    });
    expect(resolved.nextSessionState).toEqual({
      providerId: "claude",
      sessionId: undefined,
      sessionData: undefined,
      projectPath: "/tmp/project-b",
      initialProjectPath: "/tmp/project-b",
    });
  });

  it("keeps existing session linkage when path does not change", () => {
    const terminal = makeTerminal({
      sessionState: {
        providerId: "claude",
        sessionId: "session-123",
        sessionData: { id: "session-123" },
        projectPath: "/tmp/project-a",
        initialProjectPath: "/tmp/project-a",
      },
      paneStates: {
        "pane-1": {
          projectPath: "/tmp/project-a",
          sessionId: "session-123",
          embeddedTerminalId: "term-abc",
        },
      },
    });
    const workspace = {
      id: "workspace-1",
      type: "project" as const,
      projectPath: "/tmp/project-a",
      title: "Project A",
      activeTerminalTabId: terminal.id,
      terminalTabs: [terminal],
      status: "idle" as const,
      hasUnsavedChanges: false,
      order: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const resolved = resolveProjectSwitchForActiveTerminal(workspace, terminal, "/tmp/project-a/");

    expect(resolved.didProjectSwitch).toBe(false);
    expect(resolved.nextPaneState).toBeUndefined();
    expect(resolved.embeddedTerminalIdToClose).toBeUndefined();
    expect(resolved.nextSessionState).toEqual({
      providerId: "claude",
      sessionId: "session-123",
      sessionData: { id: "session-123" },
      projectPath: "/tmp/project-a",
      initialProjectPath: "/tmp/project-a",
    });
  });
});
