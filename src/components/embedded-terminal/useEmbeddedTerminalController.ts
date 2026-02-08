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
  encodeTerminalKeyInput,
  focusTerminalIfInteractive,
  getTerminalTextarea,
  isEditableTargetOutsideContainer,
  normalizeWheelDeltaToScrollLines,
  shouldRouteKeyboardFallbackInput,
} from "@/components/embedded-terminal/input";
import {
  classifyTerminalErrorCode,
  closeEmbeddedTerminalForLifecycle,
  isMissingEmbeddedTerminalError,
} from "@/components/embedded-terminal/errors";
import { shouldAttemptStaleInputRecovery } from "@/components/embedded-terminal/stale";
import { debugLog, getTauriListen } from "@/components/embedded-terminal/tauri";
import type { InteractiveTerminal, UnlistenFn } from "@/components/embedded-terminal/types";

interface UseEmbeddedTerminalControllerParams {
  projectPath: string;
  autoRunCommand?: string;
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
  error: string | null;
  ready: boolean;
  quickRunCommandRef: MutableRefObject<string>;
  runInTerminal: (command: string) => Promise<void>;
  handleRestart: () => Promise<void>;
  recoverPointerFocus: () => void;
}

export function shouldReattachUsingExistingTerminalId(
  existingTerminalId: string | undefined,
  persistentSessionId: string | undefined
): boolean {
  return Boolean(existingTerminalId) && !persistentSessionId;
}

export const TERMINAL_AUTO_FOCUS_RETRY_DELAYS_MS = [0, 80, 180, 320, 500] as const;

export type TerminalAutoFocusRetryDecision =
  | "continue"
  | "stop-missing-terminal"
  | "stop-not-interactive"
  | "stop-not-running"
  | "stop-focused"
  | "stop-editable-outside";

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
  if (isEditableTargetOutsideContainer(activeElement, container)) {
    return "stop-editable-outside";
  }
  return "continue";
}

export function useEmbeddedTerminalController({
  projectPath,
  autoRunCommand,
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
  const quickRunCommandRef = useRef<string>(quickRunCommand);
  const lastHandledRunRequestIdRef = useRef<number>(runCommandRequestId);
  const suppressAutoRecoverRef = useRef(false);
  const autoRecoverCountRef = useRef(0);
  const startupGenerationRef = useRef(0);
  const isInteractiveRef = useRef(isInteractive);
  const isRunningRef = useRef(false);
  const staleRecoveryPendingRef = useRef(false);
  const softReattachPendingRef = useRef(false);
  const lastInputAttemptAtRef = useRef<number | null>(null);
  const lastOutputAtRef = useRef<number | null>(Date.now());
  const lastStaleRecoveryAtRef = useRef(0);
  const lastOutputEventEmitAtRef = useRef(0);
  const focusRetryTimeoutIdsRef = useRef<number[]>([]);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartToken, setRestartToken] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const ready = Boolean(terminalId) && isRunning;

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
      emitTerminalEvent("soft_reattach_trigger", { reason });
      void captureIncident(reason, `Auto capture during soft reattach: ${reason}`);

      window.setTimeout(() => {
        softReattachPendingRef.current = false;
        setRestartToken((prev) => prev + 1);
      }, 80);
    },
    [captureIncident, emitTerminalEvent]
  );

  const runInTerminal = useCallback(
    async (command: string) => {
      if (!terminalIdRef.current) return;
      try {
        lastInputAttemptAtRef.current = Date.now();
        await api.writeEmbeddedTerminalInput(terminalIdRef.current, `${command}\n`);
        emitTerminalEvent("write_input_success", {
          source: "run-command",
          command,
        });
      } catch (runError) {
        const errorCode = classifyTerminalErrorCode(runError, "ERR_WRITE_FAILED");
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
    [emitTerminalEvent, scheduleSoftReattach]
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
    let viewportWheelCleanup: UnlistenFn | null = null;
    let wheelDeltaRemainder = 0;
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
      viewportWheelCleanup?.();
      viewportWheelCleanup = null;
      wheelDeltaRemainder = 0;
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
      setError(null);
      lastOutputAtRef.current = Date.now();

      onDataDisposable = terminalInstance.onData((data) => {
        if (!terminalIdRef.current) return;
        lastInputAttemptAtRef.current = Date.now();
        api.writeEmbeddedTerminalInput(terminalIdRef.current, data).catch((writeError) => {
          const errorCode = classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED");
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
        terminalIdRef.current = null;
        setTerminalId(null);
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

    const start = async () => {
      setIsStarting(true);
      setError(null);
      setIsRunning(false);
      isRunningRef.current = false;

      const term = new XTerm({
        cursorBlink: true,
        convertEol: true,
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
      const viewport = containerRef.current.querySelector(".xterm-viewport");
      if (viewport instanceof HTMLElement) {
        const handleWheel = (event: WheelEvent) => {
          event.stopImmediatePropagation();
          event.stopPropagation();
          const { lines, remainder } = normalizeWheelDeltaToScrollLines({
            deltaMode: event.deltaMode,
            deltaY: event.deltaY,
            rows: term.rows,
            remainder: wheelDeltaRemainder,
          });
          wheelDeltaRemainder = remainder;
          event.preventDefault();
          if (lines !== 0) {
            term.scrollLines(lines);
          }
        };

        viewport.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        viewportWheelCleanup = () => {
          viewport.removeEventListener("wheel", handleWheel, true);
        };
      }

      fitAddon.fit();
      applyTerminalInteractivity(term as unknown as InteractiveTerminal, isInteractiveRef.current);

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      terminalInstance = term;

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
        onTerminalIdChangeRef.current?.(id);
      } catch (startError) {
        const message = startError instanceof Error ? startError.message : "Failed to start terminal";
        emitTerminalEvent("start_failed", {
          errorCode: classifyTerminalErrorCode(startError, "ERR_LISTENER_ATTACH_FAILED"),
        });
        setError(message);
        setIsRunning(false);
        isRunningRef.current = false;
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

      if (terminalInstance) {
        terminalInstance.dispose();
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    projectPath,
    restartToken,
    runInTerminal,
    scheduleSoftReattach,
    scheduleTerminalAutoFocusRetry,
    clearAutoFocusRetryTimers,
    emitTerminalEvent,
    persistentSessionId,
  ]);

  useEffect(() => {
    const applied = applyTerminalInteractivity(
      terminalRef.current as unknown as InteractiveTerminal,
      isInteractive
    );
    if (isInteractive) {
      if (applied) {
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
      if (
        isEditableTargetOutsideContainer(target, container) ||
        isEditableTargetOutsideContainer(document.activeElement, container)
      ) {
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
        emitTerminalEvent("write_input_failed", {
          source: "keyboard-fallback",
          errorCode: classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED"),
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
  }, [isInteractive, isRunning, terminalId, scheduleSoftReattach, emitTerminalEvent]);

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
        emitTerminalEvent("write_input_failed", {
          source: "healthcheck",
          errorCode: classifyTerminalErrorCode(writeError, "ERR_WRITE_FAILED"),
        });
        if (isMissingEmbeddedTerminalError(writeError)) {
          scheduleSoftReattach("interactive-healthcheck-miss");
        }
      });
    }, 180);

    return () => {
      window.clearTimeout(healthTimer);
    };
  }, [isInteractive, isRunning, terminalId, scheduleSoftReattach, emitTerminalEvent]);

  useEffect(() => {
    if (!isRunning || !isInteractive) {
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

      emitTerminalEvent("stale_recovery_start", {
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

      window.setTimeout(() => {
        staleRecoveryPendingRef.current = false;
        if (!isInteractiveRef.current || !isRunningRef.current) {
          return;
        }
        const inputStillStale = Boolean(
          recoveryInputAt && recoveryInputAt > (lastOutputAtRef.current ?? 0)
        );
        if (!inputStillStale) {
          emitTerminalEvent("stale_recovery_done", { strategy: "focus-only" });
          return;
        }

        emitTerminalEvent("stale_recovery_done", { strategy: "soft-reattach" });
        void captureIncident(
          "stale-input-soft-reattach",
          "Auto capture after stale-input soft reattach"
        );
        setRestartToken((prev) => prev + 1);
      }, STALE_RECOVERY_GRACE_MS);
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isInteractive, isRunning, emitTerminalEvent, captureIncident]);

  useEffect(() => {
    return () => {
      staleRecoveryPendingRef.current = false;
      softReattachPendingRef.current = false;
      clearAutoFocusRetryTimers();
    };
  }, [clearAutoFocusRetryTimers]);

  const statusText = useMemo(() => {
    if (isStarting) return "Starting terminal...";
    if (ready) return "Running";
    return "Stopped";
  }, [isStarting, ready]);

  return {
    containerRef,
    statusText,
    error,
    ready,
    quickRunCommandRef,
    runInTerminal,
    handleRestart,
    recoverPointerFocus,
  };
}
