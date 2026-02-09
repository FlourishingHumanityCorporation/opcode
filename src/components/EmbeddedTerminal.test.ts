import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {},
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

const embeddedTerminalControllerMocks = vi.hoisted(() => ({
  runInTerminal: vi.fn(async () => undefined),
  handleRestart: vi.fn(async () => undefined),
  recoverPointerFocus: vi.fn(),
  quickRunCommandRef: { current: "claude" },
  containerRef: { current: null as HTMLDivElement | null },
}));

vi.mock("@/components/embedded-terminal", () => ({
  useEmbeddedTerminalController: () => ({
    containerRef: embeddedTerminalControllerMocks.containerRef,
    statusText: "Running",
    isStreamingActivity: false,
    error: null,
    recoveryNotice: null,
    ready: true,
    quickRunCommandRef: embeddedTerminalControllerMocks.quickRunCommandRef,
    runInTerminal: embeddedTerminalControllerMocks.runInTerminal,
    handleRestart: embeddedTerminalControllerMocks.handleRestart,
    recoverPointerFocus: embeddedTerminalControllerMocks.recoverPointerFocus,
  }),
}));

import {
  EmbeddedTerminal,
  applyTerminalInteractivity,
  classifyEditableTargetOutsideContainer,
  classifyTerminalErrorCode,
  closeEmbeddedTerminalForLifecycle,
  encodeTerminalKeyInput,
  focusTerminalIfInteractive,
  isMissingEmbeddedTerminalError,
  isEditableTargetOutsideContainer,
  isXtermHelperTextareaTarget,
  shouldRouteKeyboardFallbackInput,
  shouldAttemptStaleInputRecovery,
  shouldTerminatePersistentSessionForClose,
} from "@/components/EmbeddedTerminal";

async function renderEmbeddedTerminal(
  props: Partial<React.ComponentProps<typeof EmbeddedTerminal>> = {}
): Promise<{
  host: HTMLDivElement;
  container: HTMLDivElement;
  root: Root;
  cleanup: () => Promise<void>;
}> {
  const host = document.createElement("div");
  const container = document.createElement("div");
  host.appendChild(container);
  document.body.appendChild(host);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(EmbeddedTerminal, {
        projectPath: "/tmp/project",
        onSplitPane: vi.fn(),
        onClosePane: vi.fn(),
        ...props,
      })
    );
  });

  return {
    host,
    container,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("EmbeddedTerminal lifecycle close behavior", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
  });

  it("invokes header control actions while suppressing mouse event bubbling", async () => {
    const onSplitPane = vi.fn();
    const onClosePane = vi.fn();
    const bubbleClickSpy = vi.fn();
    const bubbleMouseDownSpy = vi.fn();
    const { host, container, cleanup } = await renderEmbeddedTerminal({
      onSplitPane,
      onClosePane,
      canClosePane: true,
    });

    try {
      host.addEventListener("click", bubbleClickSpy);
      host.addEventListener("mousedown", bubbleMouseDownSpy);

      const splitButton = container.querySelector('button[title="Split Right"]') as HTMLButtonElement | null;
      const closeButton = container.querySelector('button[title="Close Pane"]') as HTMLButtonElement | null;
      const runButton = container.querySelector('button[title="Run claude"]') as HTMLButtonElement | null;
      const restartButton = container.querySelector(
        'button[title="Restart terminal"]'
      ) as HTMLButtonElement | null;

      expect(splitButton).toBeTruthy();
      expect(closeButton).toBeTruthy();
      expect(runButton).toBeTruthy();
      expect(restartButton).toBeTruthy();

      await act(async () => {
        const splitMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        splitButton?.dispatchEvent(splitMouseDown);
        expect(splitMouseDown.defaultPrevented).toBe(true);

        const splitClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        splitButton?.dispatchEvent(splitClick);
        expect(splitClick.defaultPrevented).toBe(true);

        const closeClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        closeButton?.dispatchEvent(closeClick);
        expect(closeClick.defaultPrevented).toBe(true);

        const runClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        runButton?.dispatchEvent(runClick);
        expect(runClick.defaultPrevented).toBe(true);

        const restartClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        restartButton?.dispatchEvent(restartClick);
        expect(restartClick.defaultPrevented).toBe(true);
      });

      expect(onSplitPane).toHaveBeenCalledTimes(1);
      expect(onClosePane).toHaveBeenCalledTimes(1);
      expect(embeddedTerminalControllerMocks.runInTerminal).toHaveBeenCalledWith("claude");
      expect(embeddedTerminalControllerMocks.handleRestart).toHaveBeenCalledTimes(1);
      expect(bubbleClickSpy).not.toHaveBeenCalled();
      expect(bubbleMouseDownSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("hides close button when pane cannot be closed", async () => {
    const { container, cleanup } = await renderEmbeddedTerminal({
      onClosePane: vi.fn(),
      canClosePane: false,
    });

    try {
      const closeButton = container.querySelector('button[title="Close Pane"]');
      expect(closeButton).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("maps stale-startup closes to detach semantics", async () => {
    const closeSpy = vi.spyOn(api, "closeEmbeddedTerminal").mockResolvedValue();

    await closeEmbeddedTerminalForLifecycle("term-stale", "stale-startup");

    expect(closeSpy).toHaveBeenCalledWith("term-stale", {
      terminatePersistentSession: false,
    });
  });

  it("keeps terminate semantics for restart closes", async () => {
    const closeSpy = vi.spyOn(api, "closeEmbeddedTerminal").mockResolvedValue();

    await closeEmbeddedTerminalForLifecycle("term-restart", "restart");

    expect(closeSpy).toHaveBeenCalledWith("term-restart", {
      terminatePersistentSession: true,
    });
  });

  it("exposes deterministic reason-to-flag mapping", () => {
    expect(shouldTerminatePersistentSessionForClose("stale-startup")).toBe(false);
    expect(shouldTerminatePersistentSessionForClose("restart")).toBe(true);
    expect(shouldTerminatePersistentSessionForClose("default")).toBe(true);
  });

  it("disables stdin when pane is non-interactive", () => {
    const terminal = {
      options: { disableStdin: false },
      focus: vi.fn(),
    };

    const focused = applyTerminalInteractivity(terminal, false);

    expect(focused).toBe(false);
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("reenables stdin and focuses when pane becomes interactive", () => {
    const terminal = {
      options: { disableStdin: true },
      focus: vi.fn(),
    };
    const schedule = vi.fn((focus: () => void) => focus());

    const focused = applyTerminalInteractivity(terminal, true, schedule);

    expect(focused).toBe(true);
    expect(terminal.options.disableStdin).toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });

  it("focuses on pointer recovery only when interactive", () => {
    const focus = vi.fn();
    expect(focusTerminalIfInteractive({ focus }, false)).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    expect(focusTerminalIfInteractive({ focus }, true)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("detects stale input recovery candidates", () => {
    const now = 10_000;
    expect(
      shouldAttemptStaleInputRecovery({
        isInteractive: true,
        isRunning: true,
        lastInputAttemptAt: now - 9_000,
        lastOutputAt: now - 10_000,
        now,
        lastRecoveryAt: 0,
      })
    ).toBe(true);

    expect(
      shouldAttemptStaleInputRecovery({
        isInteractive: true,
        isRunning: true,
        lastInputAttemptAt: now - 500,
        lastOutputAt: now - 10_000,
        now,
        lastRecoveryAt: 0,
      })
    ).toBe(false);

    expect(
      shouldAttemptStaleInputRecovery({
        isInteractive: true,
        isRunning: true,
        lastInputAttemptAt: now - 9_000,
        lastOutputAt: now - 9_500,
        now,
        lastRecoveryAt: now - 500,
      })
    ).toBe(false);
  });

  it("detects stale embedded terminal id errors", () => {
    expect(
      isMissingEmbeddedTerminalError(new Error("Terminal session not found: term-123"))
    ).toBe(true);
    expect(isMissingEmbeddedTerminalError("terminal session NOT found")).toBe(true);
    expect(isMissingEmbeddedTerminalError(new Error("write failed"))).toBe(false);
  });

  it("classifies terminal write failures with structured error codes", () => {
    expect(
      classifyTerminalErrorCode(
        new Error("ERR_SESSION_NOT_FOUND: Terminal session not found: term-1"),
        "ERR_WRITE_FAILED"
      )
    ).toBe("ERR_SESSION_NOT_FOUND");
    expect(
      classifyTerminalErrorCode(
        new Error("ERR_WRITE_FAILED: Failed to write to terminal"),
        "ERR_WRITE_FAILED"
      )
    ).toBe("ERR_WRITE_FAILED");
    expect(
      classifyTerminalErrorCode(
        new Error("ERR_RESIZE_FAILED: Failed to resize terminal"),
        "ERR_WRITE_FAILED"
      )
    ).toBe("ERR_RESIZE_FAILED");
  });

  it("encodes common keyboard input to terminal bytes", () => {
    expect(encodeTerminalKeyInput({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe("a");
    expect(encodeTerminalKeyInput({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false })).toBe("\r");
    expect(encodeTerminalKeyInput({ key: "Backspace", ctrlKey: false, metaKey: false, altKey: false })).toBe(
      "\x7f"
    );
    expect(encodeTerminalKeyInput({ key: "ArrowUp", ctrlKey: false, metaKey: false, altKey: false })).toBe(
      "\x1b[A"
    );
    expect(encodeTerminalKeyInput({ key: "Tab", ctrlKey: false, metaKey: false, altKey: false })).toBe("\t");
  });

  it("does not encode modified shortcuts for terminal fallback writes", () => {
    expect(encodeTerminalKeyInput({ key: "c", ctrlKey: true, metaKey: false, altKey: false })).toBeNull();
    expect(encodeTerminalKeyInput({ key: "v", ctrlKey: false, metaKey: true, altKey: false })).toBeNull();
    expect(encodeTerminalKeyInput({ key: "ArrowUp", ctrlKey: false, metaKey: false, altKey: true })).toBeNull();
    expect(encodeTerminalKeyInput({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });

  it("blocks navigation keys from global keyboard fallback forwarding", () => {
    expect(
      shouldRouteKeyboardFallbackInput({
        key: "ArrowUp",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      })
    ).toBe(false);
    expect(
      shouldRouteKeyboardFallbackInput({
        key: "PageDown",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      })
    ).toBe(false);
    expect(
      shouldRouteKeyboardFallbackInput({
        key: "a",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      })
    ).toBe(true);
    expect(
      shouldRouteKeyboardFallbackInput({
        key: "c",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
      })
    ).toBe(false);
  });

  it("treats editable targets outside terminal as keyboard fallback blockers", () => {
    const container = document.createElement("div");
    const insideInput = document.createElement("input");
    const outsideInput = document.createElement("input");
    const outsideButton = document.createElement("button");
    const outsideXtermHelper = document.createElement("textarea");
    outsideXtermHelper.className = "xterm-helper-textarea";
    container.appendChild(insideInput);
    document.body.appendChild(container);
    document.body.appendChild(outsideInput);
    document.body.appendChild(outsideButton);
    document.body.appendChild(outsideXtermHelper);

    expect(isEditableTargetOutsideContainer(insideInput, container)).toBe(false);
    expect(isEditableTargetOutsideContainer(outsideInput, container)).toBe(true);
    expect(isEditableTargetOutsideContainer(outsideButton, container)).toBe(false);
    expect(isEditableTargetOutsideContainer(outsideXtermHelper, container)).toBe(false);
    expect(isXtermHelperTextareaTarget(outsideXtermHelper)).toBe(true);
    expect(classifyEditableTargetOutsideContainer(outsideXtermHelper, container)).toBe(
      "outside-xterm-helper"
    );
    expect(classifyEditableTargetOutsideContainer(outsideInput, container)).toBe("outside-editable");

    container.remove();
    outsideInput.remove();
    outsideButton.remove();
    outsideXtermHelper.remove();
  });
});
