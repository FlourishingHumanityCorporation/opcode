import { describe, expect, it, vi } from "vitest";
import {
  analyzeTerminalOutputForCommandActivity,
  autoClearReusedSessionOnAttach,
  COMMAND_ACTIVITY_FALLBACK_IDLE_MS,
  TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS,
  clampWheelScrollLinesToBuffer,
  classifyWheelEventTarget,
  extractLastMeaningfulTerminalLine,
  getTerminalAutoFocusRetryDecision,
  isPromptLikeTerminalLine,
  mergeTerminalReplayBuffer,
  resolveCommandActivityFromOutput,
  shouldAutoClearReusedSessionOnAttach,
  shouldApplyWheelScrollFallback,
  shouldEscalateStaleRecoveryFromSignals,
  shouldReattachUsingExistingTerminalId,
  stripTerminalControlSequences,
} from "@/components/embedded-terminal/useEmbeddedTerminalController";

describe("useEmbeddedTerminalController reattach policy", () => {
  it("reuses existing terminal id whenever one is available", () => {
    expect(shouldReattachUsingExistingTerminalId("term-1", undefined)).toBe(true);
    expect(
      shouldReattachUsingExistingTerminalId("term-1", "opcode_workspace_terminal_pane")
    ).toBe(true);
    expect(shouldReattachUsingExistingTerminalId(undefined, undefined)).toBe(false);
    expect(
      shouldReattachUsingExistingTerminalId(undefined, "opcode_workspace_terminal_pane")
    ).toBe(false);
  });

  it("allows reuse even during persistent-session attach", () => {
    expect(
      shouldReattachUsingExistingTerminalId("stale-terminal-id", "opcode_workspace_terminal_pane")
    ).toBe(true);
  });

  it("auto-clears only for reused sessions in clear-on-attach mode without startup command", () => {
    expect(shouldAutoClearReusedSessionOnAttach(true, true, "")).toBe(true);
    expect(shouldAutoClearReusedSessionOnAttach(true, true, "   ")).toBe(true);
  });

  it("does not auto-clear when a startup command is present", () => {
    expect(shouldAutoClearReusedSessionOnAttach(true, true, "claude --resume abc")).toBe(false);
  });

  it("does not auto-clear for fresh sessions", () => {
    expect(shouldAutoClearReusedSessionOnAttach(true, false, "")).toBe(false);
  });

  it("does not auto-clear for resume-mode attach contexts", () => {
    expect(shouldAutoClearReusedSessionOnAttach(false, true, "")).toBe(false);
  });

  it("writes ctrl+l once when auto-clear is enabled for a reused session", async () => {
    const writeInput = vi.fn().mockResolvedValue(undefined);
    const didClear = await autoClearReusedSessionOnAttach({
      terminalId: "term-1",
      clearOnAttach: true,
      reusedExistingSession: true,
      autoRunCommand: "",
      writeInput,
    });

    expect(didClear).toBe(true);
    expect(writeInput).toHaveBeenCalledTimes(1);
    expect(writeInput).toHaveBeenCalledWith("term-1", "\u000c");
  });

  it("does not write when startup command is present", async () => {
    const writeInput = vi.fn().mockResolvedValue(undefined);
    const didClear = await autoClearReusedSessionOnAttach({
      terminalId: "term-1",
      clearOnAttach: true,
      reusedExistingSession: true,
      autoRunCommand: "claude",
      writeInput,
    });

    expect(didClear).toBe(false);
    expect(writeInput).not.toHaveBeenCalled();
  });

  it("does not write for fresh sessions even if clearOnAttach is true", async () => {
    const writeInput = vi.fn().mockResolvedValue(undefined);
    const didClear = await autoClearReusedSessionOnAttach({
      terminalId: "term-1",
      clearOnAttach: true,
      reusedExistingSession: false,
      autoRunCommand: "",
      writeInput,
    });

    expect(didClear).toBe(false);
    expect(writeInput).not.toHaveBeenCalled();
  });
});

describe("useEmbeddedTerminalController command activity heuristics", () => {
  it("keeps a deterministic fallback timeout for ambiguous completion", () => {
    expect(COMMAND_ACTIVITY_FALLBACK_IDLE_MS).toBe(30_000);
  });

  it("strips ANSI and OSC terminal control sequences", () => {
    const cleaned = stripTerminalControlSequences(
      "\u001b[32mready\u001b[0m \u001b]0;title\u0007"
    );
    expect(cleaned).toBe("ready ");
  });

  it("detects common shell prompt forms", () => {
    expect(isPromptLikeTerminalLine("$")).toBe(true);
    expect(isPromptLikeTerminalLine("paul@host:~/repo %")).toBe(true);
    expect(isPromptLikeTerminalLine("PS C:\\repo>")).toBe(true);
    expect(isPromptLikeTerminalLine("processing 95%")).toBe(false);
  });

  it("extracts the last meaningful terminal line", () => {
    expect(extractLastMeaningfulTerminalLine("\n  \nhello\n  \n")).toBe("hello");
    expect(extractLastMeaningfulTerminalLine(" \n \r\n")).toBeNull();
  });

  it("classifies output chunks into command activity signals", () => {
    const activeChunk = analyzeTerminalOutputForCommandActivity(
      "",
      "\u001b[2mRunning tests...\u001b[0m\n"
    );
    expect(activeChunk.hasNonPromptOutput).toBe(true);
    expect(activeChunk.completionDetected).toBe(false);

    const completionChunk = analyzeTerminalOutputForCommandActivity(
      activeChunk.nextTail,
      "paul@host:~/repo % "
    );
    expect(completionChunk.hasNonPromptOutput).toBe(false);
    expect(completionChunk.completionDetected).toBe(true);
  });

  it("reactivates command activity after prior idle state when new non-prompt output arrives", () => {
    const analysis = analyzeTerminalOutputForCommandActivity("", "Building target...\n");
    expect(resolveCommandActivityFromOutput(false, analysis)).toBe(true);
  });

  it("deactivates command activity when prompt completion appears", () => {
    const analysis = analyzeTerminalOutputForCommandActivity("Running...\n", "\u276f ");
    expect(resolveCommandActivityFromOutput(true, analysis)).toBe(false);
  });
});

describe("useEmbeddedTerminalController terminal replay cache buffer", () => {
  it("appends chunks while preserving order", () => {
    const merged = mergeTerminalReplayBuffer("hello", " world", 1024);
    expect(merged).toBe("hello world");
  });

  it("trims oldest bytes when the replay buffer exceeds limit", () => {
    const merged = mergeTerminalReplayBuffer("abcdef", "ghijkl", 8);
    expect(merged).toBe("efghijkl");
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
