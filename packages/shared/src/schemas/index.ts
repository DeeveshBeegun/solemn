import { z } from 'zod';
import { DECIMAL_PATTERN, toAtomic } from '../financial.js';

export const decimalSchema = z
  .string()
  .regex(DECIMAL_PATTERN, 'Expected a nonnegative exact decimal string');
export const positiveDecimalSchema = decimalSchema.refine(
  (value) => DECIMAL_PATTERN.test(value) && toAtomic(value) > 0n,
  'Must be positive',
);
export const signedDecimalSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/);
export const timestampSchema = z.iso.datetime();
export const idSchema = z.uuid();
const label = z.string().trim().min(1).max(256);
const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function hasBase58Bytes(value: string, size: number): boolean {
  let decoded = 0n;
  for (const character of value) {
    const digit = base58.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (decoded > 0n) {
    decoded >>= 8n;
    bytes++;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === size;
}

export const mintAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .refine(
    (value) => hasBase58Bytes(value, 32),
    'Invalid 32-byte Solana address',
  );
export const signatureSchema = z
  .string()
  .min(64)
  .max(88)
  .refine(
    (value) => hasBase58Bytes(value, 64),
    'Invalid 64-byte transaction signature',
  );
export const riskStatusSchema = z.enum(['UNKNOWN', 'ELIGIBLE', 'REJECTED']);
export const sideSchema = z.enum(['BUY', 'SELL']);
export const executionModeSchema = z.enum(['PAPER', 'LIVE']);
export const orderStatusSchema = z.enum([
  'CREATED',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'FAILED',
  'CANCELLED',
]);

export const tokenSchema = z.strictObject({
  mintAddress: mintAddressSchema,
  name: label,
  symbol: z.string().trim().min(1).max(32),
  decimals: z.number().int().min(0).max(255),
  createdAt: timestampSchema,
  discoveredAt: timestampSchema,
  sourcePlatform: label,
  poolAddress: mintAddressSchema.nullable(),
  riskStatus: riskStatusSchema,
});

export const marketEventSchema = z.strictObject({
  id: idSchema,
  tokenMint: mintAddressSchema,
  eventType: label,
  // The collector supplies a stable source-local identity, e.g. signature:instruction:inner:log.
  sourceEventId: z.string().min(1).max(512),
  slot: z
    .string()
    .regex(/^(0|[1-9]\d{0,18})$/)
    .refine(
      (value) =>
        /^(0|[1-9]\d{0,18})$/.test(value) &&
        BigInt(value) <= 9223372036854775807n,
    )
    .nullable(),
  transactionSignature: signatureSchema.nullable(),
  eventAt: timestampSchema,
  ingestedAt: timestampSchema,
  source: label,
  rawPayload: z.record(z.string(), z.json()),
});

export const marketSnapshotSchema = z.strictObject({
  id: idSchema,
  tokenMint: mintAddressSchema,
  timestamp: timestampSchema,
  priceUsd: positiveDecimalSchema,
  poolLiquidityUsd: decimalSchema,
  volumeUsd: decimalSchema,
  buyVolumeUsd: decimalSchema,
  sellVolumeUsd: decimalSchema,
  uniqueBuyerCount: z.number().int().min(0).max(2147483647),
  source: label,
  // Metadata describes the observation, without pretending to know current freshness.
  observedAt: timestampSchema,
  maxAgeMs: z.number().int().min(0).max(2147483647),
  volumeWindowSeconds: z.number().int().positive().max(2147483647),
});

export const riskAssessmentSchema = z.strictObject({
  status: riskStatusSchema,
  reasons: z.array(label),
  assessedAt: timestampSchema,
});

export const tradingSignalSchema = z
  .strictObject({
    id: idSchema,
    tokenMint: mintAddressSchema,
    signalType: z.enum(['BUY', 'SELL', 'HOLD']),
    strategyId: label,
    strategyVersion: label,
    timestamp: timestampSchema,
    explanation: label,
    marketSnapshot: marketSnapshotSchema,
    riskAssessment: riskAssessmentSchema,
  })
  .refine((signal) => signal.tokenMint === signal.marketSnapshot.tokenMint, {
    message: 'Signal and snapshot must refer to the same token',
    path: ['marketSnapshot', 'tokenMint'],
  });

export const orderSchema = z
  .strictObject({
    id: idSchema,
    tokenMint: mintAddressSchema,
    side: sideSchema,
    executionMode: executionModeSchema,
    requestedQuantity: positiveDecimalSchema,
    status: orderStatusSchema,
    createdAt: timestampSchema,
    submittedAt: timestampSchema.nullable(),
    executedAt: timestampSchema.nullable(),
    estimatedFeesUsd: decimalSchema,
    actualFeesUsd: decimalSchema.nullable(),
  })
  .superRefine((order, context) => {
    const submitted =
      order.submittedAt === null ? null : Date.parse(order.submittedAt);
    const executed =
      order.executedAt === null ? null : Date.parse(order.executedAt);
    const invalid =
      (submitted !== null && submitted < Date.parse(order.createdAt)) ||
      (executed !== null && (submitted === null || executed < submitted)) ||
      (order.status === 'CREATED' &&
        (submitted !== null ||
          executed !== null ||
          order.actualFeesUsd !== null)) ||
      (['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED'].includes(order.status) &&
        submitted === null) ||
      (['PARTIALLY_FILLED', 'FILLED'].includes(order.status) &&
        (executed === null || order.actualFeesUsd === null));
    if (invalid)
      context.addIssue({
        code: 'custom',
        message: 'Invalid order lifecycle or timestamps',
      });
  });

export const positionSchema = z
  .strictObject({
    id: idSchema,
    tokenMint: mintAddressSchema,
    quantity: decimalSchema,
    averageEntryPriceUsd: positiveDecimalSchema,
    costBasisUsd: decimalSchema,
    realizedPnlUsd: signedDecimalSchema,
    unrealizedPnlUsd: signedDecimalSchema,
    status: z.enum(['OPEN', 'CLOSED']),
    openedAt: timestampSchema,
    closedAt: timestampSchema.nullable(),
  })
  .refine(
    (position) =>
      DECIMAL_PATTERN.test(position.quantity) &&
      (position.status === 'CLOSED'
        ? position.closedAt !== null && toAtomic(position.quantity) === 0n
        : position.closedAt === null && toAtomic(position.quantity) > 0n),
    'Invalid position lifecycle',
  );

export const tradeSchema = z.strictObject({
  id: idSchema,
  orderId: idSchema,
  tokenMint: mintAddressSchema,
  side: sideSchema,
  executedQuantity: positiveDecimalSchema,
  executionPriceUsd: positiveDecimalSchema,
  feesUsd: decimalSchema,
  timestamp: timestampSchema,
});

export const orderRequestSchema = z.strictObject({
  orderId: idSchema,
  tokenMint: mintAddressSchema,
  side: sideSchema,
  executionMode: z.literal('PAPER'),
  quantity: positiveDecimalSchema,
});
