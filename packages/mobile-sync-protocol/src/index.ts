import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

export const SnapshotV1Schema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  sequence: z.number().int().nonnegative(),
  generatedAt: z.string(),
  state: z.record(JsonValueSchema),
});

export const EventEnvelopeV1Schema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  sequence: z.number().int().nonnegative(),
  eventType: z.string().min(1),
  generatedAt: z.string(),
  payload: JsonValueSchema,
});

export const ActionRequestV1Schema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  actionId: z.string().min(1),
  actionType: z.string().min(1),
  payload: JsonValueSchema,
});

export const ActionResultV1Schema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  actionId: z.string().min(1),
  status: z.enum(['accepted', 'completed', 'failed']),
  sequence: z.number().int().nonnegative(),
  error: z.string().optional(),
  payload: JsonValueSchema.optional(),
});

export const PairingPayloadV1Schema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  pairCode: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  expiresAt: z.string(),
});

export type SnapshotV1 = z.infer<typeof SnapshotV1Schema>;
export type EventEnvelopeV1 = z.infer<typeof EventEnvelopeV1Schema>;
export type ActionRequestV1 = z.infer<typeof ActionRequestV1Schema>;
export type ActionResultV1 = z.infer<typeof ActionResultV1Schema>;
export type PairingPayloadV1 = z.infer<typeof PairingPayloadV1Schema>;

export function assertSnapshotV1(input: unknown): SnapshotV1 {
  return SnapshotV1Schema.parse(input);
}

export function assertEventEnvelopeV1(input: unknown): EventEnvelopeV1 {
  return EventEnvelopeV1Schema.parse(input);
}
