import { describe, expect, it } from "vitest";
import {
  TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS,
  getTerminalAutoFocusRetryDecision,
  shouldReattachUsingExistingTerminalId,
} from "@/components/embedded-terminal/useEmbeddedTerminalController";

describe("useEmbeddedTerminalController reattach policy", () => {
  it("reuses existing terminal id only when persistent session is absent", () => {
    expect(shouldReattachUsingExistingTerminalId("term-1", undefined)).toBe(true);
    expect(shouldReattachUsingExistingTerminalId("term-1", "opcode_workspace_terminal_pane")).toBe(
      false
    );
    expect(shouldReattachUsingExistingTerminalId(undefined, undefined)).toBe(false);
  });
});

describe("useEmbeddedTerminalController focus retry decisions", () => {
  it("keeps deterministic retry delays", () => {
    expect(TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS).toEqual([0, 80, 180, 320, 500]);
  });

  it("stops retries when terminal textarea is already focused", () => {
    const container = document.createElement("div");
    const terminalTextarea = document.createElement("textarea");
    container.appendChild(terminalTextarea);
    document.body.appendChild(container);
    terminalTextarea.focus();

    const decision = getTerminalAutoFocusRetryDecision({
      terminal: { focus: () => undefined },
      terminalTextarea,
      container,
      activeElement: document.activeElement,
      isInteractive: true,
      isRunning: true,
    });

    expect(decision).toBe("stop-focused");

    container.remove();
  });

  it("stops retries when pane is not interactive", () => {
    const decision = getTerminalAutoFocusRetryDecision({
      terminal: { focus: () => undefined },
      terminalTextarea: null,
      container: document.createElement("div"),
      activeElement: document.body,
      isInteractive: false,
      isRunning: true,
    });

    expect(decision).toBe("stop-not-interactive");
  });

  it("stops retries when user is typing in editable target outside terminal", () => {
    const container = document.createElement("div");
    const outsideInput = document.createElement("input");
    document.body.appendChild(container);
    document.body.appendChild(outsideInput);
    outsideInput.focus();

    const decision = getTerminalAutoFocusRetryDecision({
      terminal: { focus: () => undefined },
      terminalTextarea: null,
      container,
      activeElement: document.activeElement,
      isInteractive: true,
      isRunning: true,
    });

    expect(decision).toBe("stop-editable-outside");

    container.remove();
    outsideInput.remove();
  });
});
