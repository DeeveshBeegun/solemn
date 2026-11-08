import { z } from 'zod';
import {
  idSchema,
  marketEventSchema,
  timestampSchema,
  tokenSchema,
} from './schemas/index.js';

export const scannerEventSchema = z
  .strictObject({
    event: marketEventSchema.extend({
      source: z.literal('PUMPPORTAL'),
      eventType: z.enum(['TOKEN_CREATED', 'TOKEN_MIGRATED']),
      rawMessage: z.string().min(1),
    }),
    token: tokenSchema,
  })
  .refine(
    (value) => value.event.tokenMint === value.token.mintAddress,
    'Token/event mint mismatch',
  );

export type ScannerEvent = z.infer<typeof scannerEventSchema>;

export const scannerGapSchema = z
  .strictObject({
    id: idSchema,
    source: z.literal('PUMPPORTAL'),
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    reason: z.enum([
      'STARTUP',
      'DISCONNECTED',
      'CONNECTION_ERROR',
      'AUTHENTICATION_FAILED',
      'SUBSCRIPTION_TIMEOUT',
      'HEARTBEAT_TIMEOUT',
      'QUEUE_SATURATED',
      'PERSISTENCE_FAILED',
      'INVALID_MESSAGE',
      'SHUTDOWN',
      'RETRY_LIMIT',
    ]),
  })
  .refine(
    (gap) =>
      gap.endedAt === null ||
      Date.parse(gap.endedAt) >= Date.parse(gap.startedAt),
    'Gap ends before it starts',
  );

export type ScannerGap = z.infer<typeof scannerGapSchema>;
