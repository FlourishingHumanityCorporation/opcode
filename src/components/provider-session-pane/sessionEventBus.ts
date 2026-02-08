import type {
  ProviderSessionCompletionPayload,
  ProviderSessionCompletionStatus,
} from "./types";

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

function isCompletionStatus(value: unknown): value is ProviderSessionCompletionStatus {
  return value === "success" || value === "error" || value === "cancelled";
}

function pickStringField(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function normalizeProviderSessionCompletion(
  detail: unknown
): ProviderSessionCompletionPayload {
  if (typeof detail === "boolean") {
    return {
      status: detail ? "success" : "error",
      success: detail,
    };
  }

  if (!detail || typeof detail !== "object") {
    return {
      status: "error",
      success: false,
    };
  }

  const payload = detail as Record<string, unknown>;
  const rawStatus = payload.status;
  const rawSuccess = payload.success;
  const error = pickStringField(payload, "error", "message");
  const sessionId = pickStringField(payload, "sessionId", "session_id");
  const providerId = pickStringField(payload, "providerId", "provider_id");

  let status: ProviderSessionCompletionStatus | undefined = isCompletionStatus(rawStatus)
    ? rawStatus
    : undefined;

  const successFromPayload = typeof rawSuccess === "boolean" ? rawSuccess : undefined;

  if (!status) {
    if (successFromPayload !== undefined) {
      status = successFromPayload ? "success" : "error";
    } else if (typeof payload.cancelled === "boolean" && payload.cancelled) {
      status = "cancelled";
    } else if (typeof error === "string" && /cancelled|canceled|interrupted/i.test(error)) {
      status = "cancelled";
    } else {
      status = "error";
    }
  }

  const success = successFromPayload ?? status === "success";
  const normalized: ProviderSessionCompletionPayload = {
    status,
    success: status === "success" ? true : success && status !== "cancelled",
  };

  if (status !== "success") {
    normalized.success = false;
  }
  if (error) {
    normalized.error = error;
  }
  if (sessionId) {
    normalized.sessionId = sessionId;
  }
  if (providerId) {
    normalized.providerId = providerId;
  }

  return normalized;
}
