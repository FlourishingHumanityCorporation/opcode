import { api } from "@/lib/api";
import type { TerminalCloseReason, TerminalErrorFallback } from "@/components/embedded-terminal/types";

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
  fallback: TerminalErrorFallback
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
