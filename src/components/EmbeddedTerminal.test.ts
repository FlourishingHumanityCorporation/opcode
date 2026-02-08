import { describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {},
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

import {
  applyTerminalInteractivity,
  classifyTerminalErrorCode,
  closeEmbeddedTerminalForLifecycle,
  encodeTerminalKeyInput,
  focusTerminalIfInteractive,
  isMissingEmbeddedTerminalError,
  isEditableTargetOutsideContainer,
  normalizeWheelDeltaToScrollLines,
  shouldRouteKeyboardFallbackInput,
  shouldAttemptStaleInputRecovery,
  shouldTerminatePersistentSessionForClose,
} from "@/components/EmbeddedTerminal";

describe("EmbeddedTerminal lifecycle close behavior", () => {
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

  it("normalizes wheel deltas into integer scroll lines with remainder carry", () => {
    const lineMode = normalizeWheelDeltaToScrollLines({
      deltaMode: 1,
      deltaY: 3,
      rows: 40,
      remainder: 0,
    });
    expect(lineMode.lines).toBe(3);
    expect(lineMode.remainder).toBe(0);

    const firstPixel = normalizeWheelDeltaToScrollLines({
      deltaMode: 0,
      deltaY: 8,
      rows: 40,
      remainder: 0,
    });
    expect(firstPixel.lines).toBe(0);
    expect(firstPixel.remainder).toBe(0.5);

    const secondPixel = normalizeWheelDeltaToScrollLines({
      deltaMode: 0,
      deltaY: 8,
      rows: 40,
      remainder: firstPixel.remainder,
    });
    expect(secondPixel.lines).toBe(1);
    expect(secondPixel.remainder).toBe(0);

    const pageMode = normalizeWheelDeltaToScrollLines({
      deltaMode: 2,
      deltaY: -1,
      rows: 50,
      remainder: 0,
    });
    expect(pageMode.lines).toBe(-49);
    expect(pageMode.remainder).toBe(0);
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
    container.appendChild(insideInput);
    document.body.appendChild(container);
    document.body.appendChild(outsideInput);
    document.body.appendChild(outsideButton);

    expect(isEditableTargetOutsideContainer(insideInput, container)).toBe(false);
    expect(isEditableTargetOutsideContainer(outsideInput, container)).toBe(true);
    expect(isEditableTargetOutsideContainer(outsideButton, container)).toBe(false);

    container.remove();
    outsideInput.remove();
    outsideButton.remove();
  });
});
