import { afterEach, describe, expect, it } from "vitest";
import {
  buildTerminalIncidentBundle,
  clearTerminalEventSnapshot,
  getTerminalEventSnapshot,
  recordTerminalEvent,
  setTerminalWorkspaceSnapshotProvider,
  shouldCaptureDeadInputIncident,
} from "@/services/terminalHangDiagnostics";

describe("terminalHangDiagnostics", () => {
  afterEach(() => {
    clearTerminalEventSnapshot();
    setTerminalWorkspaceSnapshotProvider(null);
    localStorage.removeItem("opcode.terminal.debug");
    delete (globalThis as any).__OPCODE_DEBUG_LOGS__;
  });

  it("records terminal events even when debug mode is disabled", () => {
    recordTerminalEvent({
      event: "start_attempt",
    });
    expect(getTerminalEventSnapshot()).toHaveLength(1);
  });

  it("records and truncates terminal events in debug mode", () => {
    localStorage.setItem("opcode.terminal.debug", "1");
    for (let index = 0; index < 405; index += 1) {
      recordTerminalEvent({
        event: `event-${index}`,
      });
    }

    const events = getTerminalEventSnapshot();
    expect(events).toHaveLength(400);
    expect(events[0].event).toBe("event-5");
    expect(events[399].event).toBe("event-404");
  });

  it("builds incident bundle schema with workspace summary from provider", () => {
    setTerminalWorkspaceSnapshotProvider(() => ({
      activeTabId: "workspace-1",
      tabs: [
        {
          id: "workspace-1",
          type: "project",
          projectPath: "/tmp/project",
          title: "Project",
          activeTerminalTabId: "terminal-1",
          terminalTabs: [
            {
              id: "terminal-1",
              kind: "chat",
              title: "Terminal 1",
              paneTree: {
                id: "pane-1",
                type: "leaf",
                leafSessionId: "pane-1",
              },
              activePaneId: "pane-1",
              paneStates: {
                "pane-1": {
                  embeddedTerminalId: "term-1",
                },
              },
              status: "idle",
              hasUnsavedChanges: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          status: "idle",
          hasUnsavedChanges: false,
          order: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as any,
    }));
    recordTerminalEvent({
      event: "write_input_failed",
      payload: { errorCode: "ERR_SESSION_NOT_FOUND" },
    });

    const bundle = buildTerminalIncidentBundle(
      {
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        paneId: "pane-1",
      },
      {
        capturedAtMs: Date.now(),
        sessionCount: 1,
        sessions: [
          {
            terminalId: "term-1",
            persistentSessionId: "opcode_workspace_1",
            alive: true,
            createdAtMs: Date.now(),
            lastInputWriteMs: Date.now(),
            lastResizeMs: Date.now(),
            lastReadOutputMs: Date.now(),
            lastReadErr: null,
            lastWriteErr: null,
            lastExitReason: null,
          },
        ],
      }
    );

    expect(bundle.version).toBe(1);
    expect(bundle.classification).toBe("stale_frontend_terminal_id");
    expect(bundle.workspaceSummary?.workspaceCount).toBe(1);
    expect(bundle.frontendEvents.length).toBe(1);
  });

  it("debounces dead-input incident capture per pane key", () => {
    const now = Date.now();
    expect(shouldCaptureDeadInputIncident("ws:term:pane", now)).toBe(true);
    expect(shouldCaptureDeadInputIncident("ws:term:pane", now + 500)).toBe(false);
    expect(shouldCaptureDeadInputIncident("ws:term:pane", now + 60_100)).toBe(true);
  });

  it("classifies focus handoff blockers as interactive focus gating", () => {
    recordTerminalEvent({
      event: "focus_handoff_blocked",
      payload: { reason: "editable-target-outside-terminal" },
    });

    const bundle = buildTerminalIncidentBundle({
      workspaceId: "workspace-1",
      terminalId: "terminal-1",
      paneId: "pane-1",
    });

    expect(bundle.classification).toBe("interactive_focus_gating");
  });

  it("classifies stale escalation events when staged recovery escalates", () => {
    recordTerminalEvent({
      event: "stale_recovery_escalated",
      payload: { stage: 3 },
    });

    const bundle = buildTerminalIncidentBundle({
      workspaceId: "workspace-1",
      terminalId: "terminal-1",
      paneId: "pane-1",
    });

    expect(bundle.classification).toBe("stale_recovery_escalated");
  });

  it("classifies wheel observation events for scroll-path diagnostics", () => {
    recordTerminalEvent({
      event: "wheel_observed",
      payload: { deltaY: -120, deltaMode: 0, eventTarget: "xterm-screen" },
    });

    const bundle = buildTerminalIncidentBundle({
      workspaceId: "workspace-1",
      terminalId: "terminal-1",
      paneId: "pane-1",
    });

    expect(bundle.classification).toBe("wheel_input_observed");
  });
});
