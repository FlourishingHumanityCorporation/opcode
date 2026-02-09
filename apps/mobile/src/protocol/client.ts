import type {
  ActionRequestV1,
  EventEnvelopeV1,
  SnapshotV1,
} from '../../../../packages/mobile-sync-protocol/src';
import {
  ActionRequestV1Schema,
  EventEnvelopeV1Schema,
  SnapshotV1Schema,
} from '../../../../packages/mobile-sync-protocol/src';

export interface MobileSyncClientOptions {
  baseUrl: string;
  bearerToken: string;
}

export class MobileSyncClient {
  constructor(private readonly options: MobileSyncClientOptions) {}

  async fetchSnapshot(): Promise<SnapshotV1> {
    const response = await fetch(`${this.options.baseUrl}/mobile/v1/snapshot`, {
      headers: {
        Authorization: `Bearer ${this.options.bearerToken}`,
        'X-Opcode-Sync-Version': '1',
      },
    });

    const json = await response.json();
    return SnapshotV1Schema.parse(json.data);
  }

  connect(onEvent: (event: EventEnvelopeV1) => void): WebSocket {
    const wsUrl = this.options.baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
    const socket = new WebSocket(`${wsUrl}/mobile/v1/ws`);

    socket.onmessage = (event) => {
      const parsed = JSON.parse(String(event.data));
      onEvent(EventEnvelopeV1Schema.parse(parsed));
    };

    return socket;
  }

  async sendAction(action: Omit<ActionRequestV1, 'version'>): Promise<void> {
    const payload = ActionRequestV1Schema.parse({ ...action, version: 1 });

    await fetch(`${this.options.baseUrl}/mobile/v1/action`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.bearerToken}`,
        'X-Opcode-Sync-Version': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }
}
