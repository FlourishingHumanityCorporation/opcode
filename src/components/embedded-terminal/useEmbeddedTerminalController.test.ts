import { describe, expect, it } from "vitest";
import {
  TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS,
  clampWheelScrollLinesToBuffer,
  classifyWheelEventTarget,
  getTerminalAutoFocusRetryDecision,
  shouldApplyWheelScrollFallback,
  shouldEscalateStaleRecoveryFromSignals,
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

  it("continues retries when stale focus is another terminal xterm helper textarea", () => {
    const container = document.createElement("div");
    const outsideXtermHelper = document.createElement("textarea");
    outsideXtermHelper.className = "xterm-helper-textarea";
    document.body.appendChild(container);
    document.body.appendChild(outsideXtermHelper);
    outsideXtermHelper.focus();

    const decision = getTerminalAutoFocusRetryDecision({
      terminal: { focus: () => undefined },
      terminalTextarea: null,
      container,
      activeElement: document.activeElement,
      isInteractive: true,
      isRunning: true,
    });

    expect(decision).toBe("continue");

    container.remove();
    outsideXtermHelper.remove();
  });
});

describe("useEmbeddedTerminalController staged stale escalation", () => {
  it("does not escalate without explicit write failure signals", () => {
    const now = 100_000;
    expect(
      shouldEscalateStaleRecoveryFromSignals(
        {
          windowStartedAt: now - 2_000,
          total: 1,
          sessionNotFound: 0,
        },
        now
      )
    ).toBe(false);
  });

  it("escalates when write failures repeat within the signal window", () => {
    const now = 100_000;
    expect(
      shouldEscalateStaleRecoveryFromSignals(
        {
          windowStartedAt: now - 2_000,
          total: 2,
          sessionNotFound: 0,
        },
        now
      )
    ).toBe(true);
  });

  it("escalates immediately on session-not-found failures", () => {
    const now = 100_000;
    expect(
      shouldEscalateStaleRecoveryFromSignals(
        {
          windowStartedAt: now - 2_000,
          total: 1,
          sessionNotFound: 1,
        },
        now
      )
    ).toBe(true);
  });
});

describe("useEmbeddedTerminalController wheel observation classification", () => {
  it("classifies common xterm wheel event targets", () => {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const screenChild = document.createElement("span");
    screen.appendChild(screenChild);

    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    const viewportChild = document.createElement("span");
    viewport.appendChild(viewportChild);

    const scrollable = document.createElement("div");
    scrollable.className = "xterm-scrollable-element";
    const scrollableChild = document.createElement("span");
    scrollable.appendChild(scrollableChild);

    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";

    expect(classifyWheelEventTarget(screenChild)).toBe("xterm-screen");
    expect(classifyWheelEventTarget(viewportChild)).toBe("xterm-viewport");
    expect(classifyWheelEventTarget(scrollableChild)).toBe("xterm-scrollable");
    expect(classifyWheelEventTarget(helper)).toBe("xterm-helper-textarea");
    expect(classifyWheelEventTarget(document.createElement("button"))).toBe("other");
    expect(classifyWheelEventTarget(null)).toBe("other");
  });

  it("classifies text-node wheel targets inside xterm containers", () => {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.appendChild(document.createTextNode("terminal line"));

    expect(classifyWheelEventTarget(screen.firstChild)).toBe("xterm-screen");
  });
});

describe("useEmbeddedTerminalController wheel fallback decisions", () => {
  it("uses fallback when terminal target receives wheel but native viewport does not move", () => {
    const shouldFallback = shouldApplyWheelScrollFallback({
      eventTarget: "xterm-screen",
      isInteractive: true,
      isRunning: true,
      viewportBeforeTop: 120,
      viewportAfterTop: 120,
      bufferBefore: { ybase: 400, ydisp: 120 },
      bufferAfter: { ybase: 400, ydisp: 120 },
    });

    expect(shouldFallback).toBe(true);
  });

  it("skips fallback when native viewport moves", () => {
    const shouldFallback = shouldApplyWheelScrollFallback({
      eventTarget: "xterm-viewport",
      isInteractive: true,
      isRunning: true,
      viewportBeforeTop: 120,
      viewportAfterTop: 180,
      bufferBefore: { ybase: 400, ydisp: 120 },
      bufferAfter: { ybase: 400, ydisp: 180 },
    });

    expect(shouldFallback).toBe(false);
  });

  it("skips fallback on non-terminal wheel targets", () => {
    const shouldFallback = shouldApplyWheelScrollFallback({
      eventTarget: "other",
      isInteractive: true,
      isRunning: true,
      viewportBeforeTop: 120,
      viewportAfterTop: 120,
      bufferBefore: { ybase: 400, ydisp: 120 },
      bufferAfter: { ybase: 400, ydisp: 120 },
    });

    expect(shouldFallback).toBe(false);
  });
});

describe("useEmbeddedTerminalController wheel fallback line clamping", () => {
  it("clamps upward wheel scroll to available scrollback", () => {
    expect(
      clampWheelScrollLinesToBuffer(-10, {
        ybase: 500,
        ydisp: 3,
      })
    ).toBe(-3);
  });

  it("clamps downward wheel scroll to remaining room", () => {
    expect(
      clampWheelScrollLinesToBuffer(20, {
        ybase: 500,
        ydisp: 495,
      })
    ).toBe(5);
  });

  it("returns zero when already at bounds", () => {
    expect(
      clampWheelScrollLinesToBuffer(-1, {
        ybase: 500,
        ydisp: 0,
      })
    ).toBe(0);
    expect(
      clampWheelScrollLinesToBuffer(1, {
        ybase: 500,
        ydisp: 500,
      })
    ).toBe(0);
  });
});
