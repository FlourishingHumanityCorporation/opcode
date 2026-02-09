import { describe, expect, it } from 'vitest';

import fixture from '../../packages/mobile-sync-protocol/fixtures/event-envelope-v1.json';
import {
  EventEnvelopeV1Schema,
  PROTOCOL_VERSION,
  assertEventEnvelopeV1,
} from '../../packages/mobile-sync-protocol/src';

describe('mobile sync protocol fixtures', () => {
  it('parses event envelope fixture with schema parity', () => {
    const parsed = EventEnvelopeV1Schema.parse(fixture);

    expect(parsed.version).toBe(PROTOCOL_VERSION);
    expect(parsed.sequence).toBe(42);
    expect(parsed.eventType).toBe('workspace.updated');
    expect((parsed.payload as any).workspaceId).toBe('workspace-123');
  });

  it('assert helper validates event envelope', () => {
    const parsed = assertEventEnvelopeV1(fixture);
    expect(parsed.eventType).toBe('workspace.updated');
  });
});
