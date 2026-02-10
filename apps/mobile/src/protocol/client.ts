import type {
  ActionRequestV1,
  ActionResultV1,
  EventEnvelopeV1,
  SnapshotV1,
} from '../../../../packages/mobile-sync-protocol/src';
import {
  ActionRequestV1Schema,
  ActionResultV1Schema,
  EventEnvelopeV1Schema,
  SnapshotV1Schema,
} from '../../../../packages/mobile-sync-protocol/src';

const PROTOCOL_HEADER = 'X-CodeInterfaceX-Sync-Version';
const PROTOCOL_VERSION = '1';

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

export interface PairClaimResponse {
  version: number;
  deviceId: string;
  token: string;
  baseUrl: string;
  wsUrl: string;
}

export interface MobileSyncCredentials {
  deviceId: string;
  token: string;
  baseUrl: string;
  wsUrl: string;
}

export interface PairClaimInput {
  host: string;
  pairCode: string;
  deviceName: string;
  port?: number;
}

export interface MobileSyncClientOptions {
  baseUrl: string;
  bearerToken: string;
  wsUrl?: string;
}

export interface ConnectOptions {
  since?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: unknown) => void;
  onEvent: (event: EventEnvelopeV1) => void;
}

export class MobileSyncRequestError extends Error {
  readonly status: number;
  readonly isAuthError: boolean;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'MobileSyncRequestError';
    this.status = status;
    this.isAuthError = status === 401;
    this.body = body;
  }
}

function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/mobile/v1')) {
    return trimmed;
  }
  return `${trimmed}/mobile/v1`;
}

function normalizeWsUrl(apiBaseUrl: string, wsUrl?: string): string {
  if (wsUrl && wsUrl.trim()) {
    return wsUrl.trim().replace(/\/+$/, '');
  }

  return `${apiBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/ws`;
}

function normalizeDesktopOrigin(host: string, defaultPort: number): string {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error('Desktop host is required');
  }

  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const parsed = new URL(hasProtocol ? trimmed : `http://${trimmed}`);

  if (!parsed.port) {
    parsed.port = String(defaultPort);
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function randomActionId(actionType: string): string {
  const seed = Math.random().toString(36).slice(2, 10);
  return `${actionType}-${Date.now()}-${seed}`;
}

export class MobileSyncClient {
  private readonly apiBaseUrl: string;
  private readonly wsEndpoint: string;

  constructor(private readonly options: MobileSyncClientOptions) {
    this.apiBaseUrl = normalizeApiBaseUrl(options.baseUrl);
    this.wsEndpoint = normalizeWsUrl(this.apiBaseUrl, options.wsUrl);
  }

  static async claimPairing(input: PairClaimInput): Promise<MobileSyncCredentials> {
    const origin = normalizeDesktopOrigin(input.host, input.port ?? 8091);
    const response = await fetch(`${origin}/mobile/v1/pair/claim`, {
      method: 'POST',
      headers: {
        [PROTOCOL_HEADER]: PROTOCOL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pairCode: input.pairCode.trim().toUpperCase(),
        deviceName: input.deviceName.trim() || 'iPhone',
      }),
    });

    const body = (await response.json().catch(() => undefined)) as ApiEnvelope<PairClaimResponse> | undefined;

    if (!response.ok || !body?.success || !body.data) {
      const message = body?.error || `Pairing failed (${response.status})`;
      throw new MobileSyncRequestError(message, response.status, body);
    }

    return {
      deviceId: body.data.deviceId,
      token: body.data.token,
      baseUrl: normalizeApiBaseUrl(body.data.baseUrl),
      wsUrl: normalizeWsUrl(normalizeApiBaseUrl(body.data.baseUrl), body.data.wsUrl),
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    options?: { includeAuth?: boolean }
  ): Promise<T> {
    const headers = new Headers(init.headers || {});
    headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION);

    if (options?.includeAuth !== false) {
      headers.set('Authorization', `Bearer ${this.options.bearerToken}`);
    }

    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });

    const body = (await response.json().catch(() => undefined)) as ApiEnvelope<T> | undefined;

    if (!response.ok || !body?.success) {
      const message = body?.error || `Request failed (${response.status})`;
      throw new MobileSyncRequestError(message, response.status, body);
    }

    if (typeof body.data === 'undefined') {
      throw new MobileSyncRequestError('Missing data in response', response.status, body);
    }

    return body.data;
  }

  async fetchSnapshot(): Promise<SnapshotV1> {
    const payload = await this.request<unknown>('/snapshot', {
      method: 'GET',
    });

    return SnapshotV1Schema.parse(payload);
  }

  connect(options: ConnectOptions): WebSocket {
    const params = new URLSearchParams();
    params.set('token', this.options.bearerToken);
    params.set('since', String(options.since ?? 0));

    const separator = this.wsEndpoint.includes('?') ? '&' : '?';
    const socket = new WebSocket(`${this.wsEndpoint}${separator}${params.toString()}`);

    socket.onopen = () => {
      options.onOpen?.();
    };

    socket.onmessage = (event) => {
      const parsed = JSON.parse(String(event.data));
      options.onEvent(EventEnvelopeV1Schema.parse(parsed));
    };

    socket.onerror = (event) => {
      options.onError?.(event);
    };

    socket.onclose = () => {
      options.onClose?.();
    };

    return socket;
  }

  async sendAction(action: Omit<ActionRequestV1, 'version'>): Promise<ActionResultV1> {
    const payload = ActionRequestV1Schema.parse({ ...action, version: 1 });

    const result = await this.request<unknown>('/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return ActionResultV1Schema.parse(result);
  }

  async activateWorkspace(workspaceId: string): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('workspace.activate'),
      actionType: 'workspace.activate',
      payload: { workspaceId },
    });
  }

  async activateTab(workspaceId: string): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('tab.activate'),
      actionType: 'tab.activate',
      payload: { workspaceId },
    });
  }

  async activateTerminal(workspaceId: string, terminalTabId: string): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('terminal.activate'),
      actionType: 'terminal.activate',
      payload: { workspaceId, terminalTabId },
    });
  }

  async terminalInput(terminalId: string, data: string): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('terminal.write'),
      actionType: 'terminal.write',
      payload: { terminalId, data },
    });
  }

  async submitPrompt(projectPath: string, prompt: string, model = 'default'): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('provider_session.execute'),
      actionType: 'provider_session.execute',
      payload: { projectPath, prompt, model },
    });
  }

  async resumeSession(
    projectPath: string,
    sessionId: string,
    prompt: string,
    model = 'default'
  ): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('provider_session.resume'),
      actionType: 'provider_session.resume',
      payload: { projectPath, sessionId, prompt, model },
    });
  }

  async cancelSession(sessionId?: string): Promise<ActionResultV1> {
    return this.sendAction({
      actionId: randomActionId('provider_session.cancel'),
      actionType: 'provider_session.cancel',
      payload: sessionId ? { sessionId } : {},
    });
  }
}
