import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "@/lib/api";
import {
  captureAndPersistIncidentBundle,
  recordTerminalEvent,
  shouldCaptureDeadInputIncident,
} from "@/services/terminalHangDiagnostics";
import {
  STALE_RECOVERY_GRACE_MS,
  TERMINAL_SCROLLBACK_LINES,
} from "@/components/embedded-terminal/constants";
import {
  applyTerminalInteractivity,
  classifyEditableTargetOutsideContainer,
  encodeTerminalKeyInput,
  focusTerminalIfInteractive,
  getTerminalTextarea,
  normalizeWheelDeltaToScrollLines,
  shouldRouteKeyboardFallbackInput,
} from "@/components/embedded-terminal/input";
import {
  classifyTerminalErrorCode,
  closeEmbeddedTerminalForLifecycle,
  isMissingEmbeddedTerminalError,
} from "@/components/embedded-terminal/errors";
import {
  isInputStillStale,
  shouldAttemptStaleInputRecovery,
} from "@/components/embedded-terminal/stale";
import { debugLog, getTauriListen } from "@/components/embedded-terminal/tauri";
import type { InteractiveTerminal, UnlistenFn } from "@/components/embedded-terminal/types";

interface UseEmbeddedTerminalControllerParams {
  projectPath: string;
  autoRunCommand?: string;
  clearOnAttach?: boolean;
  quickRunCommand?: string;
  runCommandRequestId?: number;
  existingTerminalId?: string;
  persistentSessionId?: string;
  onTerminalIdChange?: (terminalId: string | undefined) => void;
  isInteractive?: boolean;
  workspaceId?: string;
  terminalTabId?: string;
  paneId?: string;
}

interface UseEmbeddedTerminalControllerResult {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  statusText: string;
  isRunning: boolean;
  isStreamingActivity: boolean;
  error: string | null;
  recoveryNotice: string | null;
  ready: boolean;
  quickRunCommandRef: MutableRefObject<string>;
  runInTerminal: (command: string) => Promise<void>;
  handleRestart: () => Promise<void>;
  recoverPointerFocus: () => void;
}

const WRITE_FAILURE_SIGNAL_WINDOW_MS = 12_000;
const STREAM_ACTIVITY_IDLE_MS = 1_600;
const STALE_RECOVERY_STAGE2_GRACE_MS = 900;
const RECOVERY_NOTICE_AUTO_CLEAR_MS = 2_400;
const WHEEL_OBSERVATION_THROTTLE_MS = 1_000;
const VIEWPORT_SCROLL_EPSILON_PX = 0.5;

export interface StaleRecoveryFailureSignals {
  windowStartedAt: number;
  total: number;
  sessionNotFound: number;
}

export function shouldEscalateStaleRecoveryFromSignals(
  signals: StaleRecoveryFailureSignals,
  now = Date.now(),
  windowMs = WRITE_FAILURE_SIGNAL_WINDOW_MS
): boolean {
  if (signals.windowStartedAt === 0) {
    return false;
  }
  if (now - signals.windowStartedAt > windowMs) {
    return false;
  }
  if (signals.sessionNotFound >= 1) {
    return true;
  }
  return signals.total >= 2;
}

export function shouldReattachUsingExistingTerminalId(
  existingTerminalId: string | undefined,
  persistentSessionId: string | undefined
): boolean {
  return Boolean(existingTerminalId) && !persistentSessionId;
}

export function shouldAutoClearReusedSessionOnAttach(
  clearOnAttach: boolean | undefined,
  reusedExistingSession: boolean,
  autoRunCommand: string | undefined
): boolean {
  if (!clearOnAttach || !reusedExistingSession) {
    return false;
  }
  return !(autoRunCommand?.trim());
}

export interface AutoClearReusedSessionOnAttachParams {
  terminalId: string;
  clearOnAttach: boolean | undefined;
  reusedExistingSession: boolean;
  autoRunCommand: string | undefined;
  writeInput: (terminalId: string, data: string) => Promise<void>;
}

export async function autoClearReusedSessionOnAttach({
  terminalId,
  clearOnAttach,
  reusedExistingSession,
  autoRunCommand,
  writeInput,
}: AutoClearReusedSessionOnAttachParams): Promise<boolean> {
  if (
    !shouldAutoClearReusedSessionOnAttach(
      clearOnAttach,
      reusedExistingSession,
      autoRunCommand
    )
  ) {
    return false;
  }
  await writeInput(terminalId, "\u000c");
  return true;
}

export const TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS = [0, 80, 180, 320, 500] as const;

export type TerminalAutoFocusRetryDecision =
  | "continue"
  | "stop-missing-terminal"
  | "stop-not-interactive"
  | "stop-not-running"
  | "stop-focused"
  | "stop-editable-outside";

export type WheelEventTargetClassification =
  | "xterm-screen"
  | "xterm-viewport"
  | "xterm-scrollable"
  | "xterm-helper-textarea"
  | "other";

interface TerminalBufferScrollState {
  ybase: number | null;
  ydisp: number | null;
}

interface WheelFallbackDecisionInput {
  eventTarget: WheelEventTargetClassification;
  isInteractive: boolean;
  isRunning: boolean;
  viewportBeforeTop: number | null;
  viewportAfterTop: number | null;
  bufferBefore: TerminalBufferScrollState;
  bufferAfter: TerminalBufferScrollState;
}

export function shouldApplyWheelScrollFallback({
  eventTarget,
  isInteractive,
  isRunning,
  viewportBeforeTop,
  viewportAfterTop,
  bufferBefore,
  bufferAfter,
}: WheelFallbackDecisionInput): boolean {
  if (!isInteractive || !isRunning || eventTarget === "other") {
    return false;
  }

  const hasViewportMeasurement = viewportBeforeTop !== null && viewportAfterTop !== null;
  const hasBufferMeasurement = bufferBefore.ydisp !== null && bufferAfter.ydisp !== null;
  if (!hasViewportMeasurement && !hasBufferMeasurement) {
    return false;
  }

  const viewportMoved =
    hasViewportMeasurement &&
    Math.abs((viewportAfterTop as number) - (viewportBeforeTop as number)) >=
      VIEWPORT_SCROLL_EPSILON_PX;
  const bufferMoved =
    hasBufferMeasurement && (bufferBefore.ydisp as number) !== (bufferAfter.ydisp as number);

  return !viewportMoved && !bufferMoved;
}

export function clampWheelScrollLinesToBuffer(
  lines: number,
  bufferState: TerminalBufferScrollState
): number {
  if (!Number.isFinite(lines) || lines === 0) {
    return 0;
  }

  const roundedLines = lines < 0 ? Math.ceil(lines) : Math.floor(lines);
  if (roundedLines === 0) {
    return 0;
  }

  if (bufferState.ybase === null || bufferState.ydisp === null) {
    return roundedLines;
  }

  const ybase = Math.max(0, bufferState.ybase);
  const ydisp = Math.max(0, Math.min(ybase, bufferState.ydisp));

  if (roundedLines < 0) {
    const maxScrollUp = ydisp;
    if (maxScrollUp <= 0) {
      return 0;
    }
    return -Math.min(Math.abs(roundedLines), maxScrollUp);
  }

  const maxScrollDown = Math.max(0, ybase - ydisp);
  if (maxScrollDown <= 0) {
    return 0;
  }
  return Math.min(roundedLines, maxScrollDown);
}

function getViewportScrollTop(container: Element | null): number | null {
  if (!container) {
    return null;
  }
  const viewport = container.querySelector(".xterm-viewport");
  return viewport instanceof HTMLElement ? viewport.scrollTop : null;
}

function getTerminalBufferScrollState(terminal: XTerm | null): TerminalBufferScrollState {
  const activeBuffer = (terminal as unknown as { buffer?: { active?: { ybase?: unknown; ydisp?: unknown } } })
    ?.buffer?.active;
  const ybase = typeof activeBuffer?.ybase === "number" ? activeBuffer.ybase : null;
  const ydisp = typeof activeBuffer?.ydisp === "number" ? activeBuffer.ydisp : null;
  return { ybase, ydisp };
}

function resolveWheelTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

export function classifyWheelEventTarget(target: EventTarget | null): WheelEventTargetClassification {
  const element = resolveWheelTargetElement(target);
  if (!element) {
    return "other";
  }
  if (element.closest(".xterm-screen, .xterm-rows")) {
    return "xterm-screen";
  }
  if (element.closest(".xterm-viewport")) {
    return "xterm-viewport";
  }
  if (element.closest(".xterm-scrollable-element")) {
    return "xterm-scrollable";
  }
  if (element.classList.contains("xterm-helper-textarea")) {
    return "xterm-helper-textarea";
  }
  return "other";
}

interface TerminalAutoFocusRetryDecisionInput {
  terminal: Pick<InteractiveTerminal, "focus"> | null | undefined;
  terminalTextarea: HTMLTextAreaElement | null;
  container: Element | null | undefined;
  activeElement: Element | null;
  isInteractive: boolean;
  isRunning: boolean;
}

export function getTerminalAutoFocusRetryDecision({
  terminal,
  terminalTextarea,
  container,
  activeElement,
  isInteractive,
  isRunning,
}: TerminalAutoFocusRetryDecisionInput): TerminalAutoFocusRetryDecision {
  if (!terminal) {
    return "stop-missing-terminal";
  }
  if (!isInteractive) {
    return "stop-not-interactive";
  }
  if (!isRunning) {
    return "stop-not-running";
  }
  if (terminalTextarea && activeElement === terminalTextarea) {
    return "stop-focused";
  }
  if (
    classifyEditableTargetOutsideContainer(activeElement, container) === "outside-editable"
  ) {
    return "stop-editable-outside";
  }
  return "continue";
}

export function useEmbeddedTerminalController({
  projectPath,
  autoRunCommand,
  clearOnAttach = false,
  quickRunCommand = "claude",
  runCommandRequestId = 0,
  existingTerminalId,
  persistentSessionId,
  onTerminalIdChange,
  isInteractive = true,
  workspaceId,
  terminalTabId,
  paneId,
}: UseEmbeddedTerminalControllerParams): UseEmbeddedTerminalControllerResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const existingTerminalIdRef = useRef<string | undefined>(existingTerminalId);
  const onTerminalIdChangeRef = useRef<typeof onTerminalIdChange>(onTerminalIdChange);
  const autoRunCommandRef = useRef<string | undefined>(autoRunCommand);
  const clearOnAttachRef = useRef<boolean>(clearOnAttach);
  const quickRunCommandRef = useRef<string>(quickRunCommand);
  const lastHandledRunRequestIdRef = useRef<number>(runCommandRequestId);
  const suppressAutoRecoverRef = useRef(false);
  const autoRecoverCountRef = useRef(0);
  const startupGenerationRef = useRef(0);
  const isInteractiveRef = useRef(isInteractive);
  const isRunningRef = useRef(false);
  const staleRecoveryPendingRef = useRef(false);
  const softReattachPendingRef = useRef(false);
  const wheelScrollRemainderRef = useRef(0);
  const lastInputAttemptAtRef = useRef<number | null>(null);
  const lastOutputAtRef = useRef<number | null>(Date.now());
  const lastStaleRecoveryAtRef = useRef(0);
  const lastOutputEventEmitAtRef = useRef(0);
  const focusRetryTimeoutIdsRef = useRef<number[]>([]);
  const recoveryNoticeClearTimeoutRef = useRef<number | null>(null);
  const writeFailureSignalRef = useRef<{
    windowStartedAt: number;
    total: number;
    sessionNotFound: number;
  }>({
    windowStartedAt: 0,
    total: 0,
    sessionNotFound: 0,
  });
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [restartToken, setRestartToken] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isStreamingActivity, setIsStreamingActivity] = useState(false);
  const streamingActivityTimerRef = useRef<number | null>(null);

  const ready = Boolean(terminalId) && isRunning;

  const clearStreamingActivityTimer = useCallback(() => {
    if (streamingActivityTimerRef.current !== null) {
      window.clearTimeout(streamingActivityTimerRef.current);
      streamingActivityTimerRef.current = null;
    }
  }, []);

  const markStreamingActivity = useCallback(() => {
    setIsStreamingActivity(true);
    clearStreamingActivityTimer();
    streamingActivityTimerRef.current = window.setTimeout(() => {
      streamingActivityTimerRef.current = null;
      setIsStreamingActivity(false);
    }, STREAM_ACTIVITY_IDLE_MS);
  }, [clearStreamingActivityTimer]);

  const clearStreamingActivity = useCallback(() => {
    clearStreamingActivityTimer();
    setIsStreamingActivity(false);
  }, [clearStreamingActivityTimer]);

  const clearRecoveryNoticeTimer = useCallback(() => {
    if (recoveryNoticeClearTimeoutRef.current !== null) {
      window.clearTimeout(recoveryNoticeClearTimeoutRef.current);
      recoveryNoticeClearTimeoutRef.current = null;
    }
  }, []);

  const setRecoveryNoticeWithTimeout = useCallback(
    (message: string | null, autoClear = false) => {
      clearRecoveryNoticeTimer();
      setRecoveryNotice(message);
      if (message && autoClear) {
        recoveryNoticeClearTimeoutRef.current = window.setTimeout(() => {
          recoveryNoticeClearTimeoutRef.current = null;
          setRecoveryNotice(null);
        }, RECOVERY_NOTICE_AUTO_CLEAR_MS);
      }
    },
    [clearRecoveryNoticeTimer]
  );

  const clearWriteFailureSignals = useCallback(() => {
    writeFailureSignalRef.current = {
      windowStartedAt: 0,
      total: 0,
      sessionNotFound: 0,
    };
  }, []);

  const recordWriteFailureSignal = useCallback((errorCode: string) => {
    const now = Date.now();
    const current = writeFailureSignalRef.current;
    if (now - current.windowStartedAt > WRITE_FAILURE_SIGNAL_WINDOW_MS) {
      writeFailureSignalRef.current = {
        windowStartedAt: now,
        total: 0,
        sessionNotFound: 0,
      };
    } else if (current.windowStartedAt === 0) {
      current.windowStartedAt = now;
    }

    writeFailureSignalRef.current.total += 1;
    if (errorCode === "ERR_SESSION_NOT_FOUND") {
      writeFailureSignalRef.current.sessionNotFound += 1;
    }
  }, []);

  const shouldEscalateStaleRecovery = useCallback((now = Date.now()): boolean => {
    const signals = writeFailureSignalRef.current;
    if (
      signals.windowStartedAt !== 0 &&
      now - signals.windowStartedAt > WRITE_FAILURE_SIGNAL_WINDOW_MS
    ) {
      clearWriteFailureSignals();
      return false;
    }
    return shouldEscalateStaleRecoveryFromSignals(signals, now, WRITE_FAILURE_SIGNAL_WINDOW_MS);
  }, [clearWriteFailureSignals]);

  const emitTerminalEvent = useCallback(
    (event: string, payload?: Record<string, unknown>) => {
      recordTerminalEvent({
        workspaceId,
        terminalId: terminalTabId,
        paneId,
        embeddedTerminalId: terminalIdRef.current || existingTerminalIdRef.current,
        event,
        payload,
      });
      debugLog(event, payload);
    },
    [workspaceId, terminalTabId, paneId]
  );

  const captureIncident = useCallback(
    async (reason: string, note: string) => {
      const key = `${workspaceId || "unknown"}:${terminalTabId || "unknown"}:${paneId || "unknown"}`;
      if (!shouldCaptureDeadInputIncident(key)) {
        return;
      }
      try {
        const incident = await captureAndPersistIncidentBundle({
          workspaceId,
          terminalId: terminalTabId,
          paneId,
          embeddedTerminalId: terminalIdRef.current || undefined,
          note,
        });
        emitTerminalEvent("incident_captured", {
          reason,
          classification: incident.bundle.classification,
          path: incident.path,
        });
      } catch (captureError) {
        emitTerminalEvent("incident_capture_failed", {
          reason,
          message: captureError instanceof Error ? captureError.message : String(captureError),
        });
      }
    },
    [workspaceId, terminalTabId, paneId, emitTerminalEvent]
  );

  const scheduleSoftReattach = useCallback(
    (reason: string) => {
      if (softReattachPendingRef.current) {
        return;
      }
      softReattachPendingRef.current = true;
      setRecoveryNoticeWithTimeout("Input stalled, reattaching...");
      emitTerminalEvent("soft_reattach_trigger", { reason });
      void captureIncident(reason, `Auto capture during soft reattach: ${reason}`);

      window.setTimeout(() => {
        softReattachPendingRef.current = false;
        setRestartToken((prev) => prev + 1);
      }, 80);
    },
    [captureIncident, emitTerminalEvent, setRecoveryNoticeWithTimeout]
  );

  const runInTerminal = useCallback(
    async (command: string) => {
      if (!terminalIdRef.current) return;
      try {
        lastInputAttemptAtRef.current = Date.now();
        await api.writeEmbeddedTerminalInput(terminalIdRef.current, `${command}\n`);
        clearWriteFailureSignals();
        markStreamingActivity();
        setRecoveryNoticeWithTimeout(null);
        emitTerminalEvent("write_input_success", {
          source: "run-command",
          command,
        });
      } catch (runError) {
        const errorCode = classifyTerminalErrorCode(runError, "ERR_WRITE_FAILED");
        recordWriteFailureSignal(errorCode);
        emitTerminalEvent("write_input_failed", {
          source: "run-command",
          errorCode,
        });
        if (isMissingEmbeddedTerminalError(runError)) {
          scheduleSoftReattach("run-command-write-miss");
        }
        const message =
          runError instanceof Error ? runError.message : "Failed to send command to terminal";
        setError(message);
      }
    },
    [
      clearWriteFailureSignals,
      emitTerminalEvent,
      markStreamingActivity,
      recordWriteFailureSignal,
      scheduleSoftReattach,
      setRecoveryNoticeWithTimeout,
    ]
  );

  const recoverPointerFocus = useCallback(() => {
    const focused = focusTerminalIfInteractive(terminalRef.current, isInteractiveRef.current);
    if (focused) {
      emitTerminalEvent("focus_recovered", { source: "pointer" });
    }
  }, [emitTerminalEvent]);

  const clearAutoFocusRetryTimers = useCallback(() => {
    focusRetryTimeoutIdsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    focusRetryTimeoutIdsRef.current = [];
  }, []);

  const scheduleTerminalAutoFocusRetry = useCallback(
    (source: "startup" | "interactive") => {
      clearAutoFocusRetryTimers();

      const runAttempt = (attempt: number) => {
        const terminal = terminalRef.current;
        const container = containerRef.current;
        const terminalTextarea = getTerminalTextarea(terminal);
        const decision = getTerminalAutoFocusRetryDecision({
          terminal,
          terminalTextarea,
          container,
          activeElement: document.activeElement,
          isInteractive: isInteractiveRef.current,
          isRunning: isRunningRef.current,
        });

        if (decision === "stop-focused") {
          emitTerminalEvent("focus_recovered", { source: "auto-retry", trigger: source, attempt });
          clearAutoFocusRetryTimers();
          return;
        }

        if (decision === "stop-editable-outside") {
          emitTerminalEvent("focus_retry_cancelled", {
            source,
            attempt,
            reason: "editable-target-outside-terminal",
          });
          clearAutoFocusRetryTimers();
          return;
        }

        if (decision !== "continue") {
          clearAutoFocusRetryTimers();
          return;
        }

        focusTerminalIfInteractive(terminal, isInteractiveRef.current);
        if (terminalTextarea && document.activeElement === terminalTextarea) {
          emitTerminalEvent("focus_recovered", { source: "auto-retry", trigger: source, attempt });
          clearAutoFocusRetryTimers();
        }
      };

      TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS.forEach((delay, attempt) => {
        const timeoutId = window.setTimeout(() => {
          runAttempt(attempt);
        }, delay);
        focusRetryTimeoutIdsRef.current.push(timeoutId);
      });
    },
    [clearAutoFocusRetryTimers, emitTerminalEvent]
  );

  const handleRestart = useCallback(async () => {
    suppressAutoRecoverRef.current = true;
    autoRecoverCountRef.current = 0;
    clearAutoFocusRetryTimers();
    emitTerminalEvent("restart_requested");
    const id = terminalIdRef.current;
    if (id) {
      await closeEmbeddedTerminalForLifecycle(id, "restart").catch(() => undefined);
      onTerminalIdChangeRef.current?.(undefined);
    }
    setRestartToken((prev) => prev + 1);
  }, [clearAutoFocusRetryTimers, emitTerminalEvent]);

  useEffect(() => {
    existingTerminalIdRef.current = existingTerminalId;
  }, [existingTerminalId]);

  useEffect(() => {
    onTerminalIdChangeRef.current = onTerminalIdChange;
  }, [onTerminalIdChange]);

  useEffect(() => {
    autoRunCommandRef.current = autoRunCommand;
  }, [autoRunCommand]);

  useEffect(() => {
    clearOnAttachRef.current = clearOnAttach;
  }, [clearOnAttach]);

  useEffect(() => {
    quickRunCommandRef.current = quickRunCommand;
  }, [quickRunCommand]);

  useEffect(() => {
    isInteractiveRef.current = isInteractive;
  }, [isInteractive]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    autoRecoverCountRef.current = 0;
  }, [persistentSessionId, projectPath]);

  useEffect(() => {
    if (!containerRef.current || !projectPath) {
      return;
    }

    const startupGeneration = startupGenerationRef.current + 1;
    startupGenerationRef.current = startupGeneration;
    suppressAutoRecoverRef.current = false;
    emitTerminalEvent("start_attempt", {
      startupGeneration,
      projectPath,
      hasExistingTerminalId: Boolean(existingTerminalIdRef.current),
      hasPersistentSessionId: Boolean(persistentSessionId),
    });

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    let onDataDisposable: { dispose: () => void } | null = null;
    let wheelObservationCleanup: UnlistenFn | null = null;
    let lastWheelObservationAt = 0;
    let terminalInstance: XTerm | null = null;

    const isCurrentStartup = () => !disposed && startupGenerationRef.current === startupGeneration;

    const detachListeners = () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      onDataDisposable?.dispose();
      onDataDisposable = null;
      outputUnlisten?.();
      outputUnlisten = null;
      exitUnlisten?.();
      exitUnlisten = null;
      wheelObservationCleanup?.();
      wheelObservationCleanup = null;
    };

    const wireTerminalSession = async (id: string, runAutoCommand: boolean): Promise<boolean> => {
      if (!terminalInstance || !fitAddonRef.current) {
        throw new Error("Terminal is not initialized");
      }
      if (!isCurrentStartup()) {
        return false;
      }

      terminalIdRef.current = id;
      setTerminalId(id);
      setIsRunning(true);
      isRunningRef.current = true;
      clearStreamingActivity();
      setError(null);
      lastOutputAtRef.current = Date.now();

      onDataDisposable = terminalInstance.onData((data) => {
        if (!terminalIdRef.current) return;
        lastInputAttemptAtRef.current = Date.now();
        api.writeEmbeddedTerminalInput(terminalIdRef.current, data).catch((writeError) => {
          const errorCode = classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED");
          recordWriteFailureSignal(errorCode);
          emitTerminalEvent("write_input_failed", {
            source: "interactive",
            errorCode,
          });
          if (isMissingEmbeddedTerminalError(writeError)) {
            scheduleSoftReattach("interactive-write-miss");
            return;
          }
          setError(
            writeError instanceof Error ? writeError.message : "Failed to write to embedded terminal"
          );
        });
      });

      const tauriListen = await getTauriListen();
      if (!tauriListen) {
        emitTerminalEvent("listener_attach_failed", {
          errorCode: "ERR_LISTENER_ATTACH_FAILED",
          stage: "tauri-listen-import",
        });
        throw new Error("Embedded terminal requires desktop Tauri runtime.");
      }
      if (!isCurrentStartup()) {
        detachListeners();
        return false;
      }

      outputUnlisten = await tauriListen(`terminal-output:${id}`, (event: any) => {
        if (!terminalInstance) return;
        lastOutputAtRef.current = Date.now();
        clearWriteFailureSignals();
        markStreamingActivity();
        setRecoveryNoticeWithTimeout(null);
        const chunk = String(event.payload ?? "");
        terminalInstance.write(chunk);
        const now = Date.now();
        if (now - lastOutputEventEmitAtRef.current > 2000) {
          lastOutputEventEmitAtRef.current = now;
          emitTerminalEvent("output_received", { bytes: chunk.length });
        }
      });
      if (!isCurrentStartup()) {
        detachListeners();
        return false;
      }

      await api.resizeEmbeddedTerminal(id, terminalInstance.cols, terminalInstance.rows);
      if (!isCurrentStartup()) {
        detachListeners();
        return false;
      }
      terminalInstance.scrollToBottom();

      exitUnlisten = await tauriListen(`terminal-exit:${id}`, () => {
        if (!terminalInstance) return;
        terminalInstance.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
        emitTerminalEvent("exit_event", { terminalId: id });
        setIsRunning(false);
        isRunningRef.current = false;
        clearStreamingActivity();
        terminalIdRef.current = null;
        setTerminalId(null);
        setRecoveryNoticeWithTimeout(null);
        onTerminalIdChangeRef.current?.(undefined);

        if (
          persistentSessionId &&
          !suppressAutoRecoverRef.current &&
          autoRecoverCountRef.current < 1
        ) {
          autoRecoverCountRef.current += 1;
          setTimeout(() => {
            setRestartToken((prev) => prev + 1);
          }, 120);
        }
      });

      resizeObserver = new ResizeObserver(() => {
        if (!terminalInstance || !fitAddonRef.current || !terminalIdRef.current) {
          return;
        }
        fitAddonRef.current.fit();
        api
          .resizeEmbeddedTerminal(terminalIdRef.current, terminalInstance.cols, terminalInstance.rows)
          .catch((resizeError) => {
            emitTerminalEvent("resize_failed", {
              errorCode: classifyTerminalErrorCode(resizeError, "ERR_RESIZE_FAILED"),
            });
          });
      });
      resizeObserver.observe(containerRef.current as HTMLDivElement);

      const commandToRun = autoRunCommandRef.current?.trim();
      if (runAutoCommand && commandToRun && isCurrentStartup()) {
        setTimeout(() => {
          void runInTerminal(commandToRun);
        }, 120);
      }
      scheduleTerminalAutoFocusRetry("startup");
      return true;
    };

    const waitForAnimationFrame = async (): Promise<void> =>
      new Promise((resolve) => {
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => resolve());
          return;
        }
        setTimeout(() => resolve(), 0);
      });

    const start = async () => {
      setIsStarting(true);
      setError(null);
      setIsRunning(false);
      isRunningRef.current = false;
      clearStreamingActivity();
      setRecoveryNoticeWithTimeout(null);

      const term = new XTerm({
        cursorBlink: true,
        convertEol: false,
        scrollback: TERMINAL_SCROLLBACK_LINES,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        fontSize: 12,
        lineHeight: 1.2,
        theme: {
          background: "#0b0f14",
          foreground: "#d7dde6",
          cursor: "#d7dde6",
          selectionBackground: "#2d3a4d",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (!containerRef.current) {
        term.dispose();
        return;
      }

      term.open(containerRef.current);
      const wheelObservationContainer = containerRef.current;
      const observeWheel = (event: WheelEvent) => {
        const eventTarget = classifyWheelEventTarget(event.target);
        const now = Date.now();
        if (now - lastWheelObservationAt < WHEEL_OBSERVATION_THROTTLE_MS) {
          // Continue to fallback logic; only telemetry emit is throttled.
        } else {
          lastWheelObservationAt = now;
          emitTerminalEvent("wheel_observed", {
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            isInteractive: isInteractiveRef.current,
            eventTarget,
          });
        }

        if (eventTarget === "other" || !isInteractiveRef.current || !isRunningRef.current) {
          return;
        }
        if (event.cancelable) {
          event.preventDefault();
        }

        const terminalForWheel = terminalInstance;
        if (!terminalForWheel) {
          return;
        }

        const viewportBeforeTop = getViewportScrollTop(wheelObservationContainer);
        const bufferBefore = getTerminalBufferScrollState(terminalForWheel);

        window.requestAnimationFrame(() => {
          if (!isCurrentStartup()) {
            return;
          }
          const activeTerminal = terminalInstance;
          if (!activeTerminal || !isInteractiveRef.current || !isRunningRef.current) {
            return;
          }

          const viewportAfterTop = getViewportScrollTop(wheelObservationContainer);
          const bufferAfter = getTerminalBufferScrollState(activeTerminal);
          const shouldFallback = shouldApplyWheelScrollFallback({
            eventTarget,
            isInteractive: isInteractiveRef.current,
            isRunning: isRunningRef.current,
            viewportBeforeTop,
            viewportAfterTop,
            bufferBefore,
            bufferAfter,
          });
          if (!shouldFallback) {
            return;
          }

          const { lines, remainder } = normalizeWheelDeltaToScrollLines({
            deltaMode: event.deltaMode,
            deltaY: event.deltaY,
            rows: activeTerminal.rows,
            remainder: wheelScrollRemainderRef.current,
          });
          wheelScrollRemainderRef.current = remainder;

          if (lines === 0) {
            return;
          }

          const clampedLines = clampWheelScrollLinesToBuffer(lines, bufferAfter);
          if (clampedLines === 0) {
            return;
          }

          activeTerminal.scrollLines(clampedLines);
          emitTerminalEvent("wheel_fallback_scroll", {
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            eventTarget,
            lines: clampedLines,
          });
        });
      };
      wheelObservationContainer.addEventListener("wheel", observeWheel, {
        passive: false,
        capture: true,
      });
      wheelObservationCleanup = () => {
        wheelObservationContainer.removeEventListener("wheel", observeWheel, true);
      };

      fitAddon.fit();
      await waitForAnimationFrame();
      if (isCurrentStartup()) {
        fitAddon.fit();
      }
      await waitForAnimationFrame();
      if (isCurrentStartup()) {
        fitAddon.fit();
      }
      applyTerminalInteractivity(term as unknown as InteractiveTerminal, isInteractiveRef.current);

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      terminalInstance = term;
      wheelScrollRemainderRef.current = 0;

      try {
        const previousTerminalId = existingTerminalIdRef.current;
        const shouldReuseExistingTerminalId = shouldReattachUsingExistingTerminalId(
          previousTerminalId,
          persistentSessionId
        );

        if (previousTerminalId && persistentSessionId) {
          emitTerminalEvent("reattach_via_persistent_session", { previousTerminalId });
          await closeEmbeddedTerminalForLifecycle(previousTerminalId, "stale-startup").catch(
            () => undefined
          );
          existingTerminalIdRef.current = undefined;
          terminalIdRef.current = null;
          setTerminalId(null);
          setIsRunning(false);
          isRunningRef.current = false;
          clearStreamingActivity();
          onTerminalIdChangeRef.current?.(undefined);
        }

        if (shouldReuseExistingTerminalId && previousTerminalId) {
          emitTerminalEvent("reattach_attempt", { previousTerminalId });
          try {
            const didReattach = await wireTerminalSession(previousTerminalId, false);
            if (didReattach) {
              emitTerminalEvent("reattach_success", { previousTerminalId });
              return;
            }
            if (!isCurrentStartup()) {
              return;
            }
          } catch {
            emitTerminalEvent("reattach_failed", {
              previousTerminalId,
              errorCode: "ERR_LISTENER_ATTACH_FAILED",
            });
            detachListeners();
            terminalIdRef.current = null;
            setTerminalId(null);
            setIsRunning(false);
            isRunningRef.current = false;
            clearStreamingActivity();
            onTerminalIdChangeRef.current?.(undefined);
          }
        }

        const started = await api.startEmbeddedTerminal(
          projectPath,
          term.cols,
          term.rows,
          persistentSessionId
        );
        const id = started.terminalId;
        emitTerminalEvent("start_success", {
          terminalId: id,
          reusedExistingSession: started.reusedExistingSession,
        });
        if (!isCurrentStartup()) {
          await closeEmbeddedTerminalForLifecycle(id, "stale-startup").catch(() => undefined);
          term.dispose();
          return;
        }

        const didWire = await wireTerminalSession(id, !started.reusedExistingSession);
        if (!didWire) {
          await closeEmbeddedTerminalForLifecycle(id, "stale-startup").catch(() => undefined);
          term.dispose();
          return;
        }

        try {
          const didAutoClear = await autoClearReusedSessionOnAttach({
            terminalId: id,
            clearOnAttach: clearOnAttachRef.current,
            reusedExistingSession: started.reusedExistingSession,
            autoRunCommand: autoRunCommandRef.current,
            writeInput: api.writeEmbeddedTerminalInput,
          });
          if (didAutoClear) {
            clearWriteFailureSignals();
            emitTerminalEvent("auto_clear_reused_session_applied", { terminalId: id });
          }
        } catch (clearError) {
          emitTerminalEvent("auto_clear_reused_session_failed", {
            terminalId: id,
            errorCode: classifyTerminalErrorCode(clearError, "ERR_WRITE_FAILED"),
          });
        }

        onTerminalIdChangeRef.current?.(id);
      } catch (startError) {
        const message = startError instanceof Error ? startError.message : "Failed to start terminal";
        emitTerminalEvent("start_failed", {
          errorCode: classifyTerminalErrorCode(startError, "ERR_LISTENER_ATTACH_FAILED"),
        });
        setError(message);
        setIsRunning(false);
        isRunningRef.current = false;
        clearStreamingActivity();
      } finally {
        setIsStarting(false);
      }
    };

    void start();

    return () => {
      disposed = true;
      suppressAutoRecoverRef.current = true;
      clearAutoFocusRetryTimers();
      detachListeners();

      terminalIdRef.current = null;
      setTerminalId(null);
      setIsRunning(false);
      isRunningRef.current = false;
      clearStreamingActivity();
      setRecoveryNoticeWithTimeout(null);

      if (terminalInstance) {
        terminalInstance.dispose();
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
      wheelScrollRemainderRef.current = 0;
    };
  }, [
    projectPath,
    restartToken,
    runInTerminal,
    scheduleSoftReattach,
    scheduleTerminalAutoFocusRetry,
    clearAutoFocusRetryTimers,
    clearStreamingActivity,
    clearWriteFailureSignals,
    recordWriteFailureSignal,
    emitTerminalEvent,
    persistentSessionId,
    setRecoveryNoticeWithTimeout,
  ]);

  useEffect(() => {
    const activeClassification =
      isInteractive
        ? classifyEditableTargetOutsideContainer(document.activeElement, containerRef.current)
        : "not-editable";
    const shouldSuppressFocusSteal = activeClassification === "outside-editable";
    const applied = applyTerminalInteractivity(
      terminalRef.current as unknown as InteractiveTerminal,
      isInteractive,
      shouldSuppressFocusSteal ? () => undefined : undefined
    );
    if (isInteractive) {
      if (applied) {
        emitTerminalEvent("focus_handoff_start", { trigger: "interactive" });
        if (activeClassification === "outside-editable") {
          emitTerminalEvent("focus_handoff_blocked", {
            trigger: "interactive",
            reason: "editable-target-outside-terminal",
          });
        } else if (focusTerminalIfInteractive(terminalRef.current, isInteractiveRef.current)) {
          emitTerminalEvent("focus_handoff_success", { trigger: "interactive" });
        } else {
          emitTerminalEvent("focus_handoff_blocked", {
            trigger: "interactive",
            reason: "focus-call-failed",
          });
        }
        emitTerminalEvent("became_interactive");
        scheduleTerminalAutoFocusRetry("interactive");
      }
      return;
    }
    clearAutoFocusRetryTimers();
    emitTerminalEvent("stdin_disabled");
  }, [
    isInteractive,
    terminalId,
    isStarting,
    emitTerminalEvent,
    scheduleTerminalAutoFocusRetry,
    clearAutoFocusRetryTimers,
  ]);

  useEffect(() => {
    if (!isInteractive || !isRunning || !terminalIdRef.current) {
      return;
    }

    const handleWindowKeydown = (event: KeyboardEvent) => {
      const id = terminalIdRef.current;
      const container = containerRef.current;
      if (!id || !container || event.defaultPrevented) {
        return;
      }
      if (!isInteractiveRef.current || !isRunningRef.current) {
        return;
      }

      const target = event.target;
      const targetClassification = classifyEditableTargetOutsideContainer(target, container);
      const activeClassification = classifyEditableTargetOutsideContainer(
        document.activeElement,
        container
      );
      if (
        targetClassification === "outside-editable" ||
        activeClassification === "outside-editable"
      ) {
        emitTerminalEvent("focus_handoff_blocked", {
          trigger: "keyboard-fallback",
          reason: "editable-target-outside-terminal",
        });
        return;
      }

      const terminalTextarea = getTerminalTextarea(terminalRef.current);
      if (terminalTextarea && document.activeElement === terminalTextarea) {
        return;
      }
      if (!shouldRouteKeyboardFallbackInput(event)) {
        return;
      }

      const input = encodeTerminalKeyInput(event);
      if (!input) {
        return;
      }

      event.preventDefault();
      focusTerminalIfInteractive(terminalRef.current, isInteractiveRef.current);
      emitTerminalEvent("focus_recovered", { source: "keyboard-fallback" });
      lastInputAttemptAtRef.current = Date.now();
      api.writeEmbeddedTerminalInput(id, input).catch((writeError) => {
        const errorCode = classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED");
        recordWriteFailureSignal(errorCode);
        emitTerminalEvent("write_input_failed", {
          source: "keyboard-fallback",
          errorCode,
        });
        if (isMissingEmbeddedTerminalError(writeError)) {
          scheduleSoftReattach("keyboard-fallback-write-miss");
        }
      });
    };

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [
    isInteractive,
    isRunning,
    terminalId,
    scheduleSoftReattach,
    emitTerminalEvent,
    recordWriteFailureSignal,
  ]);

  useEffect(() => {
    if (runCommandRequestId === lastHandledRunRequestIdRef.current) {
      return;
    }
    lastHandledRunRequestIdRef.current = runCommandRequestId;

    const command = autoRunCommandRef.current?.trim();
    if (!command || !isRunningRef.current || !terminalIdRef.current) {
      return;
    }

    void runInTerminal(command);
  }, [runCommandRequestId, runInTerminal]);

  useEffect(() => {
    if (!isInteractive || !isRunning || !terminalIdRef.current) {
      return;
    }

    const healthTimer = window.setTimeout(() => {
      const id = terminalIdRef.current;
      if (!id || !isInteractiveRef.current || !isRunningRef.current) {
        return;
      }
      api.writeEmbeddedTerminalInput(id, "").catch((writeError) => {
        const errorCode = classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED");
        recordWriteFailureSignal(errorCode);
        emitTerminalEvent("write_input_failed", {
          source: "healthcheck",
          errorCode,
        });
        if (isMissingEmbeddedTerminalError(writeError)) {
          scheduleSoftReattach("interactive-healthcheck-miss");
        }
      });
    }, 180);

    return () => {
      window.clearTimeout(healthTimer);
    };
  }, [
    isInteractive,
    isRunning,
    terminalId,
    scheduleSoftReattach,
    emitTerminalEvent,
    recordWriteFailureSignal,
  ]);

  useEffect(() => {
    if (!isRunning || !isInteractive) {
      wheelScrollRemainderRef.current = 0;
      return;
    }

    const intervalId = window.setInterval(() => {
      if (staleRecoveryPendingRef.current) {
        return;
      }
      const now = Date.now();
      const shouldRecover = shouldAttemptStaleInputRecovery({
        isInteractive: isInteractiveRef.current,
        isRunning: isRunningRef.current,
        lastInputAttemptAt: lastInputAttemptAtRef.current,
        lastOutputAt: lastOutputAtRef.current,
        now,
        lastRecoveryAt: lastStaleRecoveryAtRef.current,
      });
      if (!shouldRecover) {
        return;
      }

      staleRecoveryPendingRef.current = true;
      lastStaleRecoveryAtRef.current = now;
      const recoveryInputAt = lastInputAttemptAtRef.current;
      setRecoveryNoticeWithTimeout("Input stalled, reattaching...");

      emitTerminalEvent("stale_recovery_start", {
        stage: 1,
        terminalId: terminalIdRef.current,
        recoveryInputAt,
      });

      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (terminal) {
        const focused = focusTerminalIfInteractive(terminal, isInteractiveRef.current);
        if (focused) {
          emitTerminalEvent("focus_recovered", { source: "stale-recovery" });
        }
        fitAddon?.fit();
      }

      if (terminalIdRef.current && terminal) {
        api
          .resizeEmbeddedTerminal(terminalIdRef.current, terminal.cols, terminal.rows)
          .catch(() => undefined);
      }

      const id = terminalIdRef.current;
      if (!id) {
        staleRecoveryPendingRef.current = false;
        setRecoveryNoticeWithTimeout(null);
        return;
      }

      api
        .writeEmbeddedTerminalInput(id, "")
        .then(() => {
          clearWriteFailureSignals();
          emitTerminalEvent("write_input_success", {
            source: "stale-stage1-healthcheck",
          });
        })
        .catch((writeError) => {
          const errorCode = classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED");
          recordWriteFailureSignal(errorCode);
          emitTerminalEvent("write_input_failed", {
            source: "stale-stage1-healthcheck",
            errorCode,
          });
        })
        .finally(() => {
          if (!staleRecoveryPendingRef.current) {
            return;
          }

          window.setTimeout(() => {
            if (!staleRecoveryPendingRef.current) {
              return;
            }
            if (!isInteractiveRef.current || !isRunningRef.current) {
              staleRecoveryPendingRef.current = false;
              setRecoveryNoticeWithTimeout(null);
              return;
            }
            if (!isInputStillStale(recoveryInputAt, lastOutputAtRef.current)) {
              staleRecoveryPendingRef.current = false;
              clearWriteFailureSignals();
              setRecoveryNoticeWithTimeout("Input recovered.", true);
              emitTerminalEvent("stale_recovery_done", {
                strategy: "stage1-focus-healthcheck",
              });
              return;
            }

            const hasAnyFailureSignal =
              writeFailureSignalRef.current.total > 0 ||
              writeFailureSignalRef.current.sessionNotFound > 0;
            if (!hasAnyFailureSignal) {
              staleRecoveryPendingRef.current = false;
              // Disarm stale probing for this input attempt when healthchecks are healthy.
              lastInputAttemptAtRef.current = null;
              setRecoveryNoticeWithTimeout("Waiting for terminal output...", true);
              emitTerminalEvent("stale_recovery_done", {
                strategy: "no-failure-signal-stage1-stop",
              });
              return;
            }

            emitTerminalEvent("stale_recovery_stage2_start", {
              stage: 2,
              terminalId: terminalIdRef.current,
            });

            const stage2Terminal = terminalRef.current;
            const stage2FitAddon = fitAddonRef.current;
            if (stage2Terminal) {
              focusTerminalIfInteractive(stage2Terminal, isInteractiveRef.current);
              stage2FitAddon?.fit();
            }

            if (terminalIdRef.current && stage2Terminal) {
              api
                .resizeEmbeddedTerminal(terminalIdRef.current, stage2Terminal.cols, stage2Terminal.rows)
                .catch((resizeError) => {
                  emitTerminalEvent("resize_failed", {
                    source: "stale-stage2",
                    errorCode: classifyTerminalErrorCode(resizeError, "ERR_RESIZE_FAILED"),
                  });
                });
            }
            scheduleTerminalAutoFocusRetry("interactive");

            window.setTimeout(() => {
              staleRecoveryPendingRef.current = false;
              if (!isInteractiveRef.current || !isRunningRef.current) {
                setRecoveryNoticeWithTimeout(null);
                return;
              }
              if (!isInputStillStale(recoveryInputAt, lastOutputAtRef.current)) {
                clearWriteFailureSignals();
                setRecoveryNoticeWithTimeout("Input recovered.", true);
                emitTerminalEvent("stale_recovery_done", {
                  strategy: "stage2-focus-resize",
                });
                return;
              }

              if (!shouldEscalateStaleRecovery(Date.now())) {
                // Avoid repeated recovery loops on weak/non-escalating signals.
                lastInputAttemptAtRef.current = null;
                setRecoveryNoticeWithTimeout("Waiting for terminal output...", true);
                emitTerminalEvent("stale_recovery_done", {
                  strategy: "no-escalation-without-failure-signal",
                });
                return;
              }

              setRecoveryNoticeWithTimeout("Input stalled, reattaching...");
              emitTerminalEvent("stale_recovery_escalated", {
                stage: 3,
                terminalId: terminalIdRef.current,
                failureSignals: { ...writeFailureSignalRef.current },
              });
              void captureIncident(
                "stale-input-stage3-soft-reattach",
                "Auto capture after staged stale-input escalation"
              );
              scheduleSoftReattach("stale-stage3-soft-reattach");
            }, STALE_RECOVERY_STAGE2_GRACE_MS);
          }, STALE_RECOVERY_GRACE_MS);
        });
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    isInteractive,
    isRunning,
    emitTerminalEvent,
    captureIncident,
    clearWriteFailureSignals,
    recordWriteFailureSignal,
    scheduleSoftReattach,
    scheduleTerminalAutoFocusRetry,
    setRecoveryNoticeWithTimeout,
    shouldEscalateStaleRecovery,
  ]);

  useEffect(() => {
    return () => {
      staleRecoveryPendingRef.current = false;
      softReattachPendingRef.current = false;
      clearAutoFocusRetryTimers();
      clearRecoveryNoticeTimer();
      clearStreamingActivityTimer();
      clearWriteFailureSignals();
    };
  }, [
    clearAutoFocusRetryTimers,
    clearRecoveryNoticeTimer,
    clearStreamingActivityTimer,
    clearWriteFailureSignals,
  ]);

  const statusText = useMemo(() => {
    if (isStarting) return "Starting terminal...";
    if (ready) return "Running";
    return "Stopped";
  }, [isStarting, ready]);

  return {
    containerRef,
    statusText,
    isRunning,
    isStreamingActivity,
    error,
    recoveryNotice,
    ready,
    quickRunCommandRef,
    runInTerminal,
    handleRestart,
    recoverPointerFocus,
  };
}
