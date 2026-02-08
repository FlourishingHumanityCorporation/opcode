import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tab, TerminalTab } from "@/contexts/TabContext";
import { TerminalPaneSurface } from "@/components/TerminalPaneSurface";

const capturedClaudeProps = vi.hoisted(() => ({
  value: null as any,
}));

const useTabStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useTabState", () => ({
  useTabState: () => useTabStateMock(),
}));

vi.mock("@/components/ClaudeCodeSession", () => ({
  ClaudeCodeSession: (props: any) => {
    capturedClaudeProps.value = props;
    return React.createElement("div", { "data-testid": "mock-claude-session" });
  },
}));

function makeWorkspaceAndTerminal(): { workspace: Tab; terminal: TerminalTab } {
  const now = new Date();
  const paneId = "pane-1";
  const terminal: TerminalTab = {
    id: "terminal-1",
    kind: "chat",
    title: "Terminal 1",
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
    paneStates: {
      [paneId]: {
        projectPath: "/tmp/project",
      },
    },
    status: "idle",
    hasUnsavedChanges: false,
    createdAt: now,
    updatedAt: now,
  };

  const workspace: Tab = {
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

  return { workspace, terminal };
}

describe("TerminalPaneSurface pane activity plumbing", () => {
  let splitPaneSpy: ReturnType<typeof vi.fn>;
  let closePaneSpy: ReturnType<typeof vi.fn>;
  let activatePaneSpy: ReturnType<typeof vi.fn>;
  let updateTabSpy: ReturnType<typeof vi.fn>;
  let updatePaneStateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedClaudeProps.value = null;
    splitPaneSpy = vi.fn();
    closePaneSpy = vi.fn();
    activatePaneSpy = vi.fn();
    updateTabSpy = vi.fn();
    updatePaneStateSpy = vi.fn();
    useTabStateMock.mockReturnValue({
      splitPane: splitPaneSpy,
      closePane: closePaneSpy,
      activatePane: activatePaneSpy,
      updateTab: updateTabSpy,
      updatePaneState: updatePaneStateSpy,
    });
  });

  it("passes active pane state to ClaudeCodeSession", () => {
    const { workspace, terminal } = makeWorkspaceAndTerminal();

    renderToStaticMarkup(
      React.createElement(TerminalPaneSurface, {
        workspace,
        terminal,
        paneId: "pane-1",
        isActive: true,
        isPaneVisible: true,
      })
    );

    expect(capturedClaudeProps.value).toBeTruthy();
    expect(capturedClaudeProps.value.isPaneActive).toBe(true);
    expect(capturedClaudeProps.value.isPaneVisible).toBe(true);
    expect(capturedClaudeProps.value.workspaceId).toBe("workspace-1");
    expect(capturedClaudeProps.value.terminalTabId).toBe("terminal-1");
    expect(capturedClaudeProps.value.currentTerminalTitle).toBe("Terminal 1");
    expect(capturedClaudeProps.value.isTerminalTitleLocked).toBe(false);

    capturedClaudeProps.value.onAutoRenameTerminalTitle("Renamed from test");
    expect(updateTabSpy).toHaveBeenCalledWith("terminal-1", { title: "Renamed from test" });
  });

  it("marks inactive panes as non-interactive candidates", () => {
    const { workspace, terminal } = makeWorkspaceAndTerminal();

    renderToStaticMarkup(
      React.createElement(TerminalPaneSurface, {
        workspace,
        terminal,
        paneId: "pane-1",
        isActive: false,
        isPaneVisible: true,
      })
    );

    expect(capturedClaudeProps.value).toBeTruthy();
    expect(capturedClaudeProps.value.isPaneActive).toBe(false);
    expect(capturedClaudeProps.value.isPaneVisible).toBe(true);
  });

  it("passes title lock state to ClaudeCodeSession", () => {
    const { workspace, terminal } = makeWorkspaceAndTerminal();
    const lockedTerminal: TerminalTab = {
      ...terminal,
      titleLocked: true,
    };

    renderToStaticMarkup(
      React.createElement(TerminalPaneSurface, {
        workspace,
        terminal: lockedTerminal,
        paneId: "pane-1",
        isActive: true,
        isPaneVisible: true,
      })
    );

    expect(capturedClaudeProps.value).toBeTruthy();
    expect(capturedClaudeProps.value.isTerminalTitleLocked).toBe(true);
  });

  it("auto-renames default workspace title on first project path registration", () => {
    const { workspace, terminal } = makeWorkspaceAndTerminal();
    const workspaceWithDefaultTitle: Tab = {
      ...workspace,
      title: "Project 2",
      projectPath: "",
    };
    const terminalWithoutPath: TerminalTab = {
      ...terminal,
      sessionState: {
        ...terminal.sessionState,
        projectPath: "",
        initialProjectPath: "",
      },
      paneStates: {
        "pane-1": {
          projectPath: "",
        },
      },
    };

    renderToStaticMarkup(
      React.createElement(TerminalPaneSurface, {
        workspace: workspaceWithDefaultTitle,
        terminal: terminalWithoutPath,
        paneId: "pane-1",
        isActive: true,
        isPaneVisible: true,
      })
    );

    capturedClaudeProps.value.onProjectPathChange("/Users/paulrohde/CodeProjects/apps/VideoProcessor");

    expect(updateTabSpy).toHaveBeenCalledWith("workspace-1", {
      projectPath: "/Users/paulrohde/CodeProjects/apps/VideoProcessor",
      title: "VideoProcessor",
    });
  });
});
