import { describe, expect, it, vi } from 'vitest';

import { MobileSyncRequestError } from './protocol/client';
import {
  computeReconnectDelayMs,
  formatAgeLabel,
  isAuthError,
  runAuthFailureReset,
} from './reconnect';

describe('reconnect helpers', () => {
  it('computes bounded reconnect delay with jitter', () => {
    expect(computeReconnectDelayMs(1, 0)).toBe(1000);
    expect(computeReconnectDelayMs(2, 0.5)).toBe(2150);
    expect(computeReconnectDelayMs(10, 0)).toBe(20000);
    expect(computeReconnectDelayMs(10, 0.9)).toBe(20270);
  });

  it('formats timestamp ages for diagnostics', () => {
    const now = Date.parse('2026-02-09T12:00:00.000Z');
    expect(formatAgeLabel('2026-02-09T11:59:45.000Z', now)).toBe('15s ago');
    expect(formatAgeLabel('2026-02-09T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatAgeLabel('2026-02-09T07:00:00.000Z', now)).toBe('5h ago');
    expect(formatAgeLabel(null, now)).toBe('N/A');
  });

  it('detects auth errors via MobileSyncRequestError', () => {
    const authError = new MobileSyncRequestError('Unauthorized', 401);
    const nonAuthError = new MobileSyncRequestError('Bad request', 400);

    expect(isAuthError(authError)).toBe(true);
    expect(isAuthError(nonAuthError)).toBe(false);
    expect(isAuthError(new Error('generic'))).toBe(false);
  });

  it('runs auth failure reset side effects', async () => {
    const deps = {
      clearTimers: vi.fn(),
      closeSocket: vi.fn(),
      clearStoredCredentials: vi.fn(async () => undefined),
      clearCredentials: vi.fn(),
      resetRuntimeState: vi.fn(),
      setConnectionError: vi.fn(),
      setPairError: vi.fn(),
      resetReconnectAttempts: vi.fn(),
    };

    await runAuthFailureReset('Authentication failed', deps);

    expect(deps.clearTimers).toHaveBeenCalledTimes(1);
    expect(deps.closeSocket).toHaveBeenCalledTimes(1);
    expect(deps.resetReconnectAttempts).toHaveBeenCalledTimes(1);
    expect(deps.clearStoredCredentials).toHaveBeenCalledTimes(1);
    expect(deps.clearCredentials).toHaveBeenCalledTimes(1);
    expect(deps.resetRuntimeState).toHaveBeenCalledTimes(1);
    expect(deps.setConnectionError).toHaveBeenCalledWith('Authentication failed');
    expect(deps.setPairError).toHaveBeenCalledWith('Authentication failed');
  });
});
