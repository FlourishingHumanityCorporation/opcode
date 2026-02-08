import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCcw, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  captureAndPersistIncidentBundle,
  recordTerminalEvent,
  shouldCaptureDeadInputIncident,
} from "@/services/terminalHangDiagnostics";
import "@xterm/xterm/css/xterm.css";

type UnlistenFn = () => void;
type TerminalCloseReason = "default" | "restart" | "stale-startup";
type FocusScheduler = (focus: () => void) => void;

const STALE_INPUT_THRESHOLD_MS = 8_000;
const STALE_RECOVERY_GRACE_MS = 1_200;
const STALE_RECOVERY_COOLDOWN_MS = 2_500;

function shouldDebugLogs(): boolean {
  return Boolean(
    (import.meta as any)?.env?.DEV &&
      (globalThis as any).__OPCODE_DEBUG_LOGS__
  );
}

function debugLog(event: string, payload?: Record<string, unknown>): void {
  if (!shouldDebugLogs()) {
    return;
  }
  if (payload) {
    console.log(`[EmbeddedTerminal] ${event}`, payload);
    return;
  }
  console.log(`[EmbeddedTerminal] ${event}`);
}

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

type InteractiveTerminal = {
  options: {
    disableStdin?: boolean;
  };
  focus: () => void;
};

type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey"
>;

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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }
  return target.getAttribute("contenteditable") === "true";
}

function getTerminalTextarea(terminal: unknown): HTMLTextAreaElement | null {
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

interface StaleInputRecoveryCandidate {
  isInteractive: boolean;
  isRunning: boolean;
  lastInputAttemptAt: number | null;
  lastOutputAt: number | null;
  now: number;
  lastRecoveryAt: number;
  thresholdMs?: number;
  cooldownMs?: number;
}

export function shouldAttemptStaleInputRecovery({
  isInteractive,
  isRunning,
  lastInputAttemptAt,
  lastOutputAt,
  now,
  lastRecoveryAt,
  thresholdMs = STALE_INPUT_THRESHOLD_MS,
  cooldownMs = STALE_RECOVERY_COOLDOWN_MS,
}: StaleInputRecoveryCandidate): boolean {
  if (!isInteractive || !isRunning || !lastInputAttemptAt) {
    return false;
  }
  if (now - lastRecoveryAt < cooldownMs) {
    return false;
  }
  const outputAt = lastOutputAt ?? 0;
  if (lastInputAttemptAt <= outputAt) {
    return false;
  }
  return now - lastInputAttemptAt >= thresholdMs;
}

export function isMissingEmbeddedTerminalError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  const normalized = message.toLowerCase();
  return normalized.includes("terminal session not found");
}

export function classifyTerminalErrorCode(
  error: unknown,
  fallback: "ERR_WRITE_FAILED" | "ERR_RESIZE_FAILED" | "ERR_LISTENER_ATTACH_FAILED"
): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";

  if (message.includes("ERR_SESSION_NOT_FOUND") || isMissingEmbeddedTerminalError(error)) {
    return "ERR_SESSION_NOT_FOUND";
  }
  if (message.includes("ERR_RESIZE_FAILED")) {
    return "ERR_RESIZE_FAILED";
  }
  if (message.includes("ERR_WRITE_FAILED")) {
    return "ERR_WRITE_FAILED";
  }
  if (message.includes("ERR_LISTENER_ATTACH_FAILED")) {
    return "ERR_LISTENER_ATTACH_FAILED";
  }
  return fallback;
}

export function shouldTerminatePersistentSessionForClose(reason: TerminalCloseReason): boolean {
  return reason !== "stale-startup";
}

export async function closeEmbeddedTerminalForLifecycle(
  terminalId: string,
  reason: TerminalCloseReason
): Promise<void> {
  await api.closeEmbeddedTerminal(terminalId, {
    terminatePersistentSession: shouldTerminatePersistentSessionForClose(reason),
  });
}

let tauriListenPromise: Promise<any> | null = null;

async function getTauriListen(): Promise<any> {
  const hasTauriBridge =
    typeof window !== "undefined" &&
    (Boolean((window as any).__TAURI__) ||
      Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI_METADATA__));

  if (!hasTauriBridge) {
    return null;
  }

  if (!tauriListenPromise) {
    tauriListenPromise = import("@tauri-apps/api/event")
      .then((m) => m.listen)
      .catch((error) => {
        tauriListenPromise = null;
        console.warn("[EmbeddedTerminal] failed to load Tauri listener", error);
        return null;
      });
  }

  return tauriListenPromise;
}

interface EmbeddedTerminalProps {
  projectPath: string;
  className?: string;
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

export const EmbeddedTerminal: React.FC<EmbeddedTerminalProps> = ({
  projectPath,
  className,
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
}) => {
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
      } catch (error) {
        emitTerminalEvent("incident_capture_failed", {
          reason,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [workspaceId, terminalTabId, paneId, emitTerminalEvent]
  );

  const scheduleSoftReattach = useCallback((reason: string) => {
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
  }, [captureIncident, emitTerminalEvent]);

  const runInTerminal = useCallback(async (command: string) => {
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
  }, [emitTerminalEvent, scheduleSoftReattach]);

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

  const recoverPointerFocus = useCallback(() => {
    const focused = focusTerminalIfInteractive(terminalRef.current, isInteractiveRef.current);
    if (focused) {
      emitTerminalEvent("focus_recovered", { source: "pointer" });
    }
  }, [emitTerminalEvent]);

  const handleRestart = useCallback(async () => {
    suppressAutoRecoverRef.current = true;
    autoRecoverCountRef.current = 0;
    emitTerminalEvent("restart_requested");
    const id = terminalIdRef.current;
    if (id) {
      await closeEmbeddedTerminalForLifecycle(id, "restart").catch(() => undefined);
      onTerminalIdChangeRef.current?.(undefined);
    }
    setRestartToken((prev) => prev + 1);
  }, [emitTerminalEvent]);

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
    };

    const wireTerminalSession = async (id: string, runAutoCommand: boolean): Promise<boolean> => {
      if (!terminalInstance || !fitAddonRef.current) {
        throw new Error("Terminal is not initialized");
      }
      if (!isCurrentStartup()) {
        return false;
      }

      await api.resizeEmbeddedTerminal(id, terminalInstance.cols, terminalInstance.rows);
      if (!isCurrentStartup()) {
        return false;
      }

      terminalIdRef.current = id;
      setTerminalId(id);
      setIsRunning(true);
      setError(null);
      lastOutputAtRef.current = Date.now();

      onDataDisposable = terminalInstance.onData((data) => {
        if (!terminalIdRef.current) return;
        lastInputAttemptAtRef.current = Date.now();
        api.writeEmbeddedTerminalInput(terminalIdRef.current, data).catch((error) => {
          const errorCode = classifyTerminalErrorCode(error, "ERR_WRITE_FAILED");
          emitTerminalEvent("write_input_failed", {
            source: "interactive",
            errorCode,
          });
          if (isMissingEmbeddedTerminalError(error)) {
            scheduleSoftReattach("interactive-write-miss");
            return;
          }
          setError(
            error instanceof Error ? error.message : "Failed to write to embedded terminal"
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

      exitUnlisten = await tauriListen(`terminal-exit:${id}`, () => {
        if (!terminalInstance) return;
        terminalInstance.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
        emitTerminalEvent("exit_event", { terminalId: id });
        setIsRunning(false);
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
          .catch((error) => {
            emitTerminalEvent("resize_failed", {
              errorCode: classifyTerminalErrorCode(error, "ERR_RESIZE_FAILED"),
            });
          });
      });
      resizeObserver.observe(containerRef.current as HTMLDivElement);

      const commandToRun = autoRunCommandRef.current?.trim();
      if (runAutoCommand && commandToRun && isCurrentStartup()) {
        setTimeout(() => {
          runInTerminal(commandToRun);
        }, 120);
      }
      return true;
    };

    const start = async () => {
      setIsStarting(true);
      setError(null);
      setIsRunning(false);

      const term = new XTerm({
        cursorBlink: true,
        convertEol: true,
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
      fitAddon.fit();
      applyTerminalInteractivity(term as unknown as InteractiveTerminal, isInteractiveRef.current);

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      terminalInstance = term;

      try {
        const previousTerminalId = existingTerminalIdRef.current;
        if (previousTerminalId) {
          emitTerminalEvent("reattach_attempt", { previousTerminalId });
          try {
            const didReattach = await wireTerminalSession(previousTerminalId, false);
            if (didReattach) {
              emitTerminalEvent("reattach_success", { previousTerminalId });
              term.writeln(`\x1b[90m[opcode] reattached shell at ${projectPath}\x1b[0m`);
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
            onTerminalIdChangeRef.current?.(undefined);
          }
        }

        term.writeln(`\x1b[90m[opcode] shell started at ${projectPath}\x1b[0m`);
        const started = await api.startEmbeddedTerminal(projectPath, term.cols, term.rows, persistentSessionId);
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
      } finally {
        setIsStarting(false);
      }
    };

    start();

    return () => {
      disposed = true;
      suppressAutoRecoverRef.current = true;
      detachListeners();

      terminalIdRef.current = null;
      setTerminalId(null);
      setIsRunning(false);

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
        window.setTimeout(() => {
          focusTerminalIfInteractive(terminalRef.current, isInteractiveRef.current);
        }, 120);
      }
      return;
    }
    emitTerminalEvent("stdin_disabled");
  }, [isInteractive, terminalId, isStarting, emitTerminalEvent]);

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
      if (target instanceof Node && target !== document.body && !container.contains(target)) {
        return;
      }

      const terminalTextarea = getTerminalTextarea(terminalRef.current);
      if (terminalTextarea && document.activeElement === terminalTextarea) {
        return;
      }
      if (isEditableTarget(target)) {
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
      api.writeEmbeddedTerminalInput(id, input).catch((error) => {
        emitTerminalEvent("write_input_failed", {
          source: "keyboard-fallback",
          errorCode: classifyTerminalErrorCode(error, "ERR_WRITE_FAILED"),
        });
        if (isMissingEmbeddedTerminalError(error)) {
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
      api.writeEmbeddedTerminalInput(id, "").catch((error) => {
        emitTerminalEvent("write_input_failed", {
          source: "healthcheck",
          errorCode: classifyTerminalErrorCode(error, "ERR_WRITE_FAILED"),
        });
        if (isMissingEmbeddedTerminalError(error)) {
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
          recoveryInputAt &&
            recoveryInputAt > (lastOutputAtRef.current ?? 0)
        );
        if (!inputStillStale) {
          emitTerminalEvent("stale_recovery_done", { strategy: "focus-only" });
          return;
        }

        emitTerminalEvent("stale_recovery_done", { strategy: "soft-reattach" });
        void captureIncident("stale-input-soft-reattach", "Auto capture after stale-input soft reattach");
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
    };
  }, []);

  const statusText = useMemo(() => {
    if (isStarting) return "Starting terminal...";
    if (ready) return "Running";
    return "Stopped";
  }, [isStarting, ready]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-8 items-center justify-between border-b border-[var(--color-chrome-border)] px-2">
        <div className="font-mono text-[11px] text-muted-foreground">{statusText}</div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => runInTerminal(quickRunCommandRef.current || "claude")}
            disabled={!ready}
            title={`Run ${quickRunCommandRef.current || "claude"}`}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={handleRestart}
            title="Restart terminal"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 bg-[#0b0f14]"
        tabIndex={0}
        onMouseDown={recoverPointerFocus}
        onClick={recoverPointerFocus}
      />

      {error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
};

export default EmbeddedTerminal;
