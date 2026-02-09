import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileSyncClient, MobileSyncRequestError } from './client';

class FakeWebSocket {
  static lastUrl = '';

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    FakeWebSocket.lastUrl = url;
  }

  close() {
    this.onclose?.();
  }
}

describe('MobileSyncClient', () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.restoreAllMocks();
    FakeWebSocket.lastUrl = '';
    (globalThis as any).WebSocket = FakeWebSocket as any;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }

    if (originalWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('claims pairing successfully', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          version: 1,
          deviceId: 'device-1',
          token: 'token-1',
          baseUrl: 'http://100.64.0.1:8091/mobile/v1',
          wsUrl: 'ws://100.64.0.1:8091/mobile/v1/ws',
        },
      }),
    })) as any;

    const credentials = await MobileSyncClient.claimPairing({
      host: '100.64.0.1:8091',
      pairCode: 'abc123',
      deviceName: 'iPhone',
    });

    expect(credentials.deviceId).toBe('device-1');
    expect(credentials.token).toBe('token-1');
    expect(credentials.baseUrl).toBe('http://100.64.0.1:8091/mobile/v1');
    expect(credentials.wsUrl).toBe('ws://100.64.0.1:8091/mobile/v1/ws');
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe('http://100.64.0.1:8091/mobile/v1/pair/claim');
  });

  it('surfaces pairing API errors', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: 'Invalid pairing code',
      }),
    })) as any;

    await expect(
      MobileSyncClient.claimPairing({
        host: '100.64.0.1',
        pairCode: 'BAD999',
        deviceName: 'iPhone',
      })
    ).rejects.toMatchObject({
      status: 401,
      message: 'Invalid pairing code',
      isAuthError: true,
    });
  });

  it('connect builds websocket URL with token and since', () => {
    const client = new MobileSyncClient({
      baseUrl: 'http://100.64.0.1:8091/mobile/v1',
      wsUrl: 'ws://100.64.0.1:8091/mobile/v1/ws',
      bearerToken: 'token-1',
    });

    client.connect({
      since: 42,
      onEvent: vi.fn(),
    });

    expect(FakeWebSocket.lastUrl).toContain('ws://100.64.0.1:8091/mobile/v1/ws?');
    expect(FakeWebSocket.lastUrl).toContain('token=token-1');
    expect(FakeWebSocket.lastUrl).toContain('since=42');
  });
});
