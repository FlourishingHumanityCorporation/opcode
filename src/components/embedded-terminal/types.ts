export type UnlistenFn = () => void;

export type TerminalCloseReason = "default" | "restart" | "stale-startup";

export type FocusScheduler = (focus: () => void) => void;

export type InteractiveTerminal = {
  options: {
    disableStdin?: boolean;
  };
  focus: () => void;
};

export type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey"
>;

export interface WheelScrollDeltaInput {
  deltaMode: number;
  deltaY: number;
  rows: number;
  remainder: number;
}

export interface WheelScrollDeltaResult {
  lines: number;
  remainder: number;
}

export interface StaleInputRecoveryCandidate {
  isInteractive: boolean;
  isRunning: boolean;
  lastInputAttemptAt: number | null;
  lastOutputAt: number | null;
  now: number;
  lastRecoveryAt: number;
  thresholdMs?: number;
  cooldownMs?: number;
}

export type TerminalErrorFallback =
  | "ERR_WRITE_FAILED"
  | "ERR_RESIZE_FAILED"
  | "ERR_LISTENER_ATTACH_FAILED";
