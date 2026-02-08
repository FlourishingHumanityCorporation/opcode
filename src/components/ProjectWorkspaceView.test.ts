import { describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "@/contexts/TabContext";
import { toggleTerminalTitleLock } from "@/components/ProjectWorkspaceView";

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
  it("toggles terminal title lock state via updateTab", () => {
    const updateTab = vi.fn();
    const terminal = makeTerminal({ titleLocked: false });

    toggleTerminalTitleLock(updateTab, terminal);
    expect(updateTab).toHaveBeenCalledWith("terminal-1", { titleLocked: true });

    const lockedTerminal = makeTerminal({ titleLocked: true });
    toggleTerminalTitleLock(updateTab, lockedTerminal);
    expect(updateTab).toHaveBeenLastCalledWith("terminal-1", { titleLocked: false });
  });
});
