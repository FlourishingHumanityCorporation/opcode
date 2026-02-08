import {
  FALLBACK_BLOCKED_NAVIGATION_KEYS,
  WHEEL_DELTA_MODE_LINE,
  WHEEL_DELTA_MODE_PAGE,
  WHEEL_PIXEL_DELTA_PER_LINE,
} from "@/components/embedded-terminal/constants";
import type {
  FocusScheduler,
  InteractiveTerminal,
  TerminalKeyboardEvent,
  WheelScrollDeltaInput,
  WheelScrollDeltaResult,
} from "@/components/embedded-terminal/types";

const XTERM_HELPER_TEXTAREA_CLASS = "xterm-helper-textarea";

function scheduleFocusTask(focus: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      focus();
    });
    return;
  }
  setTimeout(() => {
    focus();
  }, 0);
}

export function applyTerminalInteractivity(
  terminal: InteractiveTerminal | null | undefined,
  isInteractive: boolean,
  scheduleFocus: FocusScheduler = scheduleFocusTask
): boolean {
  if (!terminal) {
    return false;
  }

  terminal.options.disableStdin = !isInteractive;
  if (!isInteractive) {
    return false;
  }

  scheduleFocus(() => {
    terminal.focus();
  });
  return true;
}

export function focusTerminalIfInteractive(
  terminal: Pick<InteractiveTerminal, "focus"> | null | undefined,
  isInteractive: boolean
): boolean {
  if (!terminal || !isInteractive) {
    return false;
  }
  terminal.focus();
  return true;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }
  return target.getAttribute("contenteditable") === "true";
}

export function isXtermHelperTextareaTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLTextAreaElement)) {
    return false;
  }
  return target.classList.contains(XTERM_HELPER_TEXTAREA_CLASS);
}

export type EditableOutsideContainerClassification =
  | "not-editable"
  | "inside-container"
  | "outside-editable"
  | "outside-xterm-helper";

export function classifyEditableTargetOutsideContainer(
  target: EventTarget | null,
  container: Element | null | undefined
): EditableOutsideContainerClassification {
  if (!isEditableTarget(target)) {
    return "not-editable";
  }
  if (!(target instanceof Node)) {
    return isXtermHelperTextareaTarget(target) ? "outside-xterm-helper" : "outside-editable";
  }
  if (!container) {
    return isXtermHelperTextareaTarget(target) ? "outside-xterm-helper" : "outside-editable";
  }
  if (container.contains(target)) {
    return "inside-container";
  }
  return isXtermHelperTextareaTarget(target) ? "outside-xterm-helper" : "outside-editable";
}

export function isEditableTargetOutsideContainer(
  target: EventTarget | null,
  container: Element | null | undefined
): boolean {
  return classifyEditableTargetOutsideContainer(target, container) === "outside-editable";
}

export function getTerminalTextarea(terminal: unknown): HTMLTextAreaElement | null {
  if (!terminal || typeof terminal !== "object") {
    return null;
  }
  const maybeTextarea = (terminal as { textarea?: unknown }).textarea;
  return maybeTextarea instanceof HTMLTextAreaElement ? maybeTextarea : null;
}

export function encodeTerminalKeyInput(event: TerminalKeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Backspace":
      return "\x7f";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      return event.key.length === 1 ? event.key : null;
  }
}

export function shouldRouteKeyboardFallbackInput(event: TerminalKeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  return !FALLBACK_BLOCKED_NAVIGATION_KEYS.has(event.key);
}

export function normalizeWheelDeltaToScrollLines({
  deltaMode,
  deltaY,
  rows,
  remainder,
}: WheelScrollDeltaInput): WheelScrollDeltaResult {
  const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 24;
  const safeRemainder = Number.isFinite(remainder) ? remainder : 0;

  let lineDelta: number;
  switch (deltaMode) {
    case WHEEL_DELTA_MODE_LINE:
      lineDelta = deltaY;
      break;
    case WHEEL_DELTA_MODE_PAGE:
      lineDelta = deltaY * Math.max(1, safeRows - 1);
      break;
    default:
      lineDelta = deltaY / WHEEL_PIXEL_DELTA_PER_LINE;
      break;
  }

  const totalDelta = lineDelta + safeRemainder;
  const lines = totalDelta < 0 ? Math.ceil(totalDelta) : Math.floor(totalDelta);
  return {
    lines,
    remainder: totalDelta - lines,
  };
}
