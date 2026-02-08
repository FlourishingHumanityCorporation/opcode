export type UnlistenFn = () => void;

export const PROVIDER_SESSION_EVENT_NAMES = {
  output: "provider-session-output",
  error: "provider-session-error",
  complete: "provider-session-complete",
  cancelled: "provider-session-cancelled",
} as const;

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
      .catch(() => {
        tauriListenPromise = null;
        return null;
      });
  }

  return tauriListenPromise;
}

function domListen(eventName: string, callback: (event: any) => void): Promise<UnlistenFn> {
  const handler = (event: any) => callback({ payload: event.detail });
  window.addEventListener(eventName, handler);
  return Promise.resolve(() => {
    window.removeEventListener(eventName, handler);
  });
}

export async function listenToProviderSessionEvent(
  eventName: string,
  callback: (event: any) => void
): Promise<UnlistenFn> {
  const tauriListen = await getTauriListen();
  if (tauriListen) {
    return tauriListen(eventName, callback);
  }
  return domListen(eventName, callback);
}

export function providerSessionScopedEvent(eventName: string, sessionId: string): string {
  return `${eventName}:${sessionId}`;
}
