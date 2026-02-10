import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tab, TerminalTab } from "@/contexts/TabContext";
import {
  TerminalPaneSurface,
  countLeafPanes,
  isInteractiveTarget,
  resolveTerminalStatusFromStreaming,
} from "@/components/TerminalPaneSurface";
import { api } from "@/lib/api";

const capturedProviderSessionProps = vi.hoisted(() => ({
  value: null as any,
}));

const useTabStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useTabState", () => ({
  useTabState: () => useTabStateMock(),
}));

vi.mock("@/components/ProviderSessionPane", () => ({
  ProviderSessionPane: (props: any) => {
    capturedProviderSessionProps.value = props;
    return React.createElement("div", { "data-testid": "mock-provider-session-pane" });
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
    vi.restoreAllMocks();
    capturedProviderSessionProps.value = null;
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

  it("maps streaming changes to running/idle transitions", () => {
    expect(resolveTerminalStatusFromStreaming("idle", true)).toBe("running");
    expect(resolveTerminalStatusFromStreaming("running", true)).toBeNull();
    expect(resolveTerminalStatusFromStreaming("running", false)).toBe("idle");
    expect(resolveTerminalStatusFromStreaming("attention", false)).toBeNull();
    expect(resolveTerminalStatusFromStreaming("complete", false)).toBeNull();
  });

  it("counts leaf panes for single and split trees", () => {
    expect(
      countLeafPanes({
        id: "pane-1",
        type: "leaf",
        leafSessionId: "pane-1",
      })
    ).toBe(1);

    expect(
      countLeafPanes({
        id: "split-root",
        type: "split",
        direction: "vertical",
        widthRatio: 0.5,
        left: {
          id: "pane-left",
          type: "leaf",
          leafSessionId: "pane-left",
        },
        right: {
          id: "pane-right",
          type: "leaf",
          leafSessionId: "pane-right",
        },
      })
    ).toBe(2);
  });

  it("detects interactive targets for pane activation guard", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    const textarea = document.createElement("textarea");
    const xtermHelper = document.createElement("textarea");
    xtermHelper.className = "xterm-helper-textarea";
    const plain = document.createElement("div");
    const roleButton = document.createElement("span");
    roleButton.setAttribute("role", "button");
    const noActivate = document.createElement("span");
    noActivate.setAttribute("data-no-pane-activate", "true");
    root.appendChild(button);
    root.appendChild(textarea);
    root.appendChild(xtermHelper);
    root.appendChild(plain);
    root.appendChild(roleButton);
    root.appendChild(noActivate);

    expect(isInteractiveTarget(button)).toBe(true);
    expect(isInteractiveTarget(textarea)).toBe(true);
    expect(isInteractiveTarget(xtermHelper)).toBe(false);
    expect(isInteractiveTarget(roleButton)).toBe(true);
    expect(isInteractiveTarget(noActivate)).toBe(true);
    expect(isInteractiveTarget(plain)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });

  it("passes active pane state to ProviderSessionPane", () => {
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

    expect(capturedProviderSessionProps.value).toBeTruthy();
    expect(capturedProviderSessionProps.value.isPaneActive).toBe(true);
    expect(capturedProviderSessionProps.value.isPaneVisible).toBe(true);
    expect(capturedProviderSessionProps.value.workspaceId).toBe("workspace-1");
    expect(capturedProviderSessionProps.value.terminalTabId).toBe("terminal-1");
    expect(capturedProviderSessionProps.value.currentTerminalTitle).toBe("Terminal 1");
    expect(capturedProviderSessionProps.value.isTerminalTitleLocked).toBe(false);
    expect(capturedProviderSessionProps.value.canClosePane).toBe(false);
    expect(typeof capturedProviderSessionProps.value.onPaneActivate).toBe("function");

    capturedProviderSessionProps.value.onAutoRenameTerminalTitle("Renamed from test");
    expect(updateTabSpy).toHaveBeenCalledWith("terminal-1", { title: "Renamed from test" });
  });

  it("activates the current pane when onPaneActivate is invoked", () => {
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

    expect(capturedProviderSessionProps.value).toBeTruthy();
    capturedProviderSessionProps.value.onPaneActivate();
    expect(activatePaneSpy).toHaveBeenCalledWith("workspace-1", "terminal-1", "pane-1");
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

    expect(capturedProviderSessionProps.value).toBeTruthy();
    expect(capturedProviderSessionProps.value.isPaneActive).toBe(false);
    expect(capturedProviderSessionProps.value.isPaneVisible).toBe(true);
  });

  it("passes title lock state to ProviderSessionPane", () => {
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

    expect(capturedProviderSessionProps.value).toBeTruthy();
    expect(capturedProviderSessionProps.value.isTerminalTitleLocked).toBe(true);
  });

  it("enables pane close controls when pane tree has multiple leaves", () => {
    const { workspace, terminal } = makeWorkspaceAndTerminal();
    const splitTerminal: TerminalTab = {
      ...terminal,
      paneTree: {
        id: "root",
        type: "split",
        direction: "vertical",
        widthRatio: 0.5,
        left: {
          id: "pane-1",
          type: "leaf",
          leafSessionId: "pane-1",
        },
        right: {
          id: "pane-2",
          type: "leaf",
          leafSessionId: "pane-2",
        },
      },
      paneStates: {
        "pane-1": {
          projectPath: "/tmp/project",
        },
        "pane-2": {
          projectPath: "/tmp/project",
        },
      },
      activePaneId: "pane-1",
    };

    renderToStaticMarkup(
      React.createElement(TerminalPaneSurface, {
        workspace,
        terminal: splitTerminal,
        paneId: "pane-1",
        isActive: true,
        isPaneVisible: true,
      })
    );

    expect(capturedProviderSessionProps.value).toBeTruthy();
    expect(capturedProviderSessionProps.value.canClosePane).toBe(true);
    expect(typeof capturedProviderSessionProps.value.onClosePane).toBe("function");
  });

  it("auto-renames default workspace title on first project path registration", () => {
    const closeEmbeddedTerminalSpy = vi
      .spyOn(api, "closeEmbeddedTerminal")
      .mockResolvedValue(undefined);
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
        sessionId: "session-123",
        projectPath: "",
        initialProjectPath: "",
      },
      paneStates: {
        "pane-1": {
          sessionId: "session-123",
          embeddedTerminalId: "term-abc",
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

    capturedProviderSessionProps.value.onProjectPathChange("/Users/paulrohde/CodeProjects/apps/VideoProcessor");

    expect(closeEmbeddedTerminalSpy).toHaveBeenCalledWith("term-abc");
    expect(updateTabSpy).toHaveBeenCalledWith("terminal-1", {
      sessionState: expect.objectContaining({
        sessionId: undefined,
        sessionData: undefined,
        projectPath: "/Users/paulrohde/CodeProjects/apps/VideoProcessor",
        initialProjectPath: "/Users/paulrohde/CodeProjects/apps/VideoProcessor",
      }),
    });
    expect(updatePaneStateSpy).toHaveBeenCalledWith("workspace-1", "terminal-1", "pane-1", {
      projectPath: "/Users/paulrohde/CodeProjects/apps/VideoProcessor",
      embeddedTerminalId: undefined,
      sessionId: undefined,
      restorePreference: "start_fresh",
    });
    expect(updateTabSpy).toHaveBeenCalledWith("workspace-1", {
      projectPath: "/Users/paulrohde/CodeProjects/apps/VideoProcessor",
      title: "VideoProcessor",
    });
  });
});
