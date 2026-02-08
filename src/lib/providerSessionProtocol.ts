export type ProviderSessionCompletionStatus = "success" | "error" | "cancelled";

export interface ProviderSessionCompletionPayload {
  status: ProviderSessionCompletionStatus;
  success: boolean;
  error?: string;
  sessionId?: string;
  providerId?: string;
}

export interface ProviderSessionMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  message?: {
    content?: any[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  session_id?: string;
  provider_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  error?: string;
  result?: string;
  timestamp?: string;
  [key: string]: any;
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

export function normalizeProviderSessionCompletionPayload(
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

  const normalized: ProviderSessionCompletionPayload = {
    status,
    success: status === "success",
  };

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

export function normalizeProviderSessionMessage(
  payload: unknown
): ProviderSessionMessage | null {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as ProviderSessionMessage;
    } catch {
      return null;
    }
  }
  if (typeof payload === "object") {
    return payload as ProviderSessionMessage;
  }
  return null;
}
