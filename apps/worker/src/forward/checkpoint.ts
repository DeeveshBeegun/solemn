import { z } from 'zod';
import {
  buyCandidateSchema,
  idSchema,
  preparedQuoteSchema,
  strategyStateSchema,
  timestampSchema,
} from '@solemn/shared';

const timing = {
  id: idSchema,
  triggerAt: timestampSchema,
  expiresAt: timestampSchema,
  quote: preparedQuoteSchema.nullable(),
};
const intentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...timing,
    kind: z.literal('ENTRY'),
    candidate: buyCandidateSchema,
  }),
  z.strictObject({
    ...timing,
    kind: z.literal('EXIT'),
    positionId: idSchema,
    reason: z.string(),
    quantity: z.string(),
  }),
]);
export const replayCheckpointSchema = z.strictObject({
  cursor: timestampSchema.nullable(),
  connected: z.boolean(),
  tracked: z.number().int().nonnegative(),
  lastTradeAt: timestampSchema.nullable(),
  lastObservationAt: timestampSchema.nullable(),
  lastCandleAt: timestampSchema.nullable(),
  lastSignalAt: timestampSchema.nullable(),
  signals: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  gaps: z.number().int().nonnegative(),
  reconnections: z.number().int().nonnegative(),
  downtimeMs: z.number().int().nonnegative(),
  feedHealth: z.enum(['HEALTHY', 'DEGRADED', 'DISCONNECTED', 'STALE']),
  states: z.record(z.string(), strategyStateSchema),
  pending: z.array(intentSchema).max(200),
  failures: z.record(idSchema, z.number().int().nonnegative()),
  unavailable: z.array(idSchema).max(100),
});
export type ReplayCheckpoint = z.infer<typeof replayCheckpointSchema>;
export type ForwardIntent = z.infer<typeof intentSchema>;
export const initialReplayCheckpoint = (): ReplayCheckpoint => ({
  cursor: null,
  connected: false,
  tracked: 0,
  lastTradeAt: null,
  lastObservationAt: null,
  lastCandleAt: null,
  lastSignalAt: null,
  signals: 0,
  warnings: 0,
  errors: 0,
  gaps: 0,
  reconnections: 0,
  downtimeMs: 0,
  feedHealth: 'DEGRADED',
  states: {},
  pending: [],
  failures: {},
  unavailable: [],
});
