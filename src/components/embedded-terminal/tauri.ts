let tauriListenPromise: Promise<any> | null = null;

function shouldDebugLogs(): boolean {
  return Boolean(
    (import.meta as any)?.env?.DEV &&
      (globalThis as any).__OPCODE_DEBUG_LOGS__
  );
}

export function debugLog(event: string, payload?: Record<string, unknown>): void {
  if (!shouldDebugLogs()) {
    return;
  }
  if (payload) {
    console.log(`[EmbeddedTerminal] ${event}`, payload);
    return;
  }
  console.log(`[EmbeddedTerminal] ${event}`);
}

export async function getTauriListen(): Promise<any> {
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
