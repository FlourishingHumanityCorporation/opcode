import { MobileSyncRequestError } from './protocol/client';

export function computeReconnectDelayMs(attempt: number, randomValue = Math.random()): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const clampedRandom = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 0.9999) : 0;
  const baseDelay = Math.min(20_000, 1000 * 2 ** (normalizedAttempt - 1));
  const jitter = Math.floor(clampedRandom * 300);
  return baseDelay + jitter;
}

export function formatAgeLabel(timestamp: string | null, nowMs = Date.now()): string {
  if (!timestamp) {
    return 'N/A';
  }

  const parsedMs = Date.parse(timestamp);
  if (Number.isNaN(parsedMs)) {
    return 'N/A';
  }

  const diffMs = Math.max(0, nowMs - parsedMs);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function isAuthError(error: unknown): boolean {
  return error instanceof MobileSyncRequestError && error.isAuthError;
}

interface AuthFailureResetDeps {
  clearTimers: () => void;
  closeSocket: () => void;
  clearStoredCredentials: () => Promise<void>;
  clearCredentials: () => void;
  resetRuntimeState: () => void;
  setConnectionError: (message: string) => void;
  setPairError: (message: string) => void;
  resetReconnectAttempts: () => void;
}

export async function runAuthFailureReset(
  message: string,
  deps: AuthFailureResetDeps
): Promise<void> {
  deps.clearTimers();
  deps.closeSocket();
  deps.resetReconnectAttempts();
  await deps.clearStoredCredentials();
  deps.clearCredentials();
  deps.resetRuntimeState();
  deps.setConnectionError(message);
  deps.setPairError(message);
}
