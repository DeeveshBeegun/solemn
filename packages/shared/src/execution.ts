import { z } from 'zod';
import {
  decimalSchema,
  positiveDecimalSchema,
  timestampSchema,
  idSchema,
  mintAddressSchema,
} from './schemas/index.js';
const units = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
const bps = z.number().int().min(0).max(9999);
export const feeScheduleSchema = z
  .strictObject({
    source: z.string().min(1),
    kind: z.enum(['RESEARCH', 'HISTORICAL']),
    validFrom: timestampSchema,
    validUntil: timestampSchema,
    lpBps: bps,
    protocolBps: bps,
    creatorBps: bps,
    routingBps: bps,
    integratorBps: bps,
  })
  .refine(
    (v) =>
      v.validFrom < v.validUntil &&
      v.lpBps + v.protocolBps + v.creatorBps + v.routingBps + v.integratorBps <
        10000,
    'Invalid fee period or combined fee',
  );
const transfer = z.strictObject({ bps, maximumUnits: units });
export const poolSnapshotSchema = z
  .strictObject({
    id: idSchema,
    poolAddress: mintAddressSchema,
    baseMint: mintAddressSchema,
    quoteMint: mintAddressSchema,
    model: z.enum([
      'REFERENCE_CPMM_V1',
      'PUMP_BONDING',
      'PUMPSWAP',
      'CLMM',
      'DLMM',
      'MULTIHOP',
      'UNKNOWN',
    ]),
    baseDecimals: z.number().int().min(0).max(18),
    quoteDecimals: z.number().int().min(0).max(18),
    baseReserve: units,
    quoteReserve: units,
    quoteUsd: positiveDecimalSchema.nullable(),
    observedAt: timestampSchema,
    availableAt: timestampSchema,
    source: z.string().min(1),
    quality: z.enum(['VERIFIED', 'SYNTHETIC', 'UNKNOWN']),
    transfers: z.enum(['ENABLED', 'FROZEN', 'RESTRICTED', 'UNKNOWN']),
    fees: feeScheduleSchema,
    baseTransferFee: transfer.nullable(),
    quoteTransferFee: transfer.nullable(),
    networkHint: z
      .enum(['NORMAL', 'DROPPED', 'FAILED_ON_CHAIN', 'UNVERIFIABLE', 'EXPIRED'])
      .default('NORMAL'),
  })
  .refine((v) => v.baseMint !== v.quoteMint, 'Pool assets must differ')
  .refine(
    (v) => v.observedAt <= v.availableAt,
    'Pool cannot be available before observed',
  );
export type PoolSnapshot = z.infer<typeof poolSnapshotSchema>;
export const nativeUsdSchema = z
  .strictObject({
    priceUsd: positiveDecimalSchema,
    observedAt: timestampSchema,
    availableAt: timestampSchema,
    source: z.string().min(1),
  })
  .refine((v) => v.observedAt <= v.availableAt);
export type NativeUsd = z.infer<typeof nativeUsdSchema>;
export const executionConfigSchema = z
  .strictObject({
    modelVersion: z.literal('SOLEMN_EXECUTION_V1'),
    revision: z.string().min(1).max(64).optional(),
    mode: z.literal('PAPER'),
    seed: z.number().int().nonnegative().max(2147483647),
    scenario: z.enum(['idealized', 'baseline', 'pessimistic', 'extreme']),
    maxSlippageBps: bps,
    maxQuoteAgeMs: z.number().int().positive().max(300000),
    latency: z.strictObject({
      processingMs: z.number().int().nonnegative().max(60000),
      quoteMs: z.number().int().nonnegative().max(60000),
      preparationMs: z.number().int().nonnegative().max(60000),
      submissionMs: z.number().int().nonnegative().max(60000),
      landingMs: z.number().int().nonnegative().max(60000),
    }),
    network: z.strictObject({
      format: z.enum(['LEGACY', 'V0', 'V1']),
      signatures: z.number().int().min(1).max(64),
      baseLamportsPerSignature: units,
      computeUnitLimit: z.number().int().min(1).max(1400000),
      microLamportsPerCu: units,
      absolutePriorityLamports: units,
      tipLamports: units,
      routeRequiresTip: z.boolean(),
      availableLamports: units,
      rentDepositLamports: units,
      source: z.string().min(1),
      validFrom: timestampSchema,
      validUntil: timestampSchema,
    }),
    droppedBps: bps,
    failedBps: bps,
    ambiguousBps: bps,
    networkOutages: z
      .array(
        z
          .strictObject({ start: timestampSchema, end: timestampSchema })
          .refine((v) => v.start < v.end),
      )
      .max(100)
      .optional(),
    maxAttemptsPerPosition: z.number().int().min(1).max(20),
  })
  .superRefine((v, c) => {
    if (v.droppedBps + v.failedBps + v.ambiguousBps > 10000)
      c.addIssue({
        code: 'custom',
        message: 'Outcome probabilities exceed 100%',
      });
    if (v.network.validFrom >= v.network.validUntil)
      c.addIssue({ code: 'custom', message: 'Invalid network fee period' });
    if (v.network.format === 'V1' && v.network.microLamportsPerCu !== '0')
      c.addIssue({
        code: 'custom',
        message: 'V1 uses an absolute priority fee',
      });
    if (v.network.format !== 'V1' && v.network.absolutePriorityLamports !== '0')
      c.addIssue({ code: 'custom', message: 'Legacy/v0 use CU price' });
    if (!v.network.routeRequiresTip && v.network.tipLamports !== '0')
      c.addIssue({ code: 'custom', message: 'Tip requires an explicit route' });
  });
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export const preparedQuoteSchema = z.strictObject({
  pool: poolSnapshotSchema.nullable(),
  at: timestampSchema,
  triggerAt: timestampSchema,
  dueAt: timestampSchema,
  side: z.enum(['BUY', 'SELL']),
  quantity: positiveDecimalSchema,
  inputUnits: units,
  outputUnits: units,
  limitUnits: units,
  error: z.string().nullable(),
});
export type PreparedQuote = z.infer<typeof preparedQuoteSchema>;
export const executionContextSchema = z.strictObject({
  runId: idSchema,
  config: executionConfigSchema,
  quote: preparedQuoteSchema,
  pool: poolSnapshotSchema.nullable(),
  nativeUsd: nativeUsdSchema.nullable(),
  randomKey: z.string().min(1),
});
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export const executionOutcomeSchema = z.enum([
  'FILLED',
  'REJECTED_BEFORE_SUBMISSION',
  'FAILED_ON_CHAIN',
  'DROPPED',
  'EXPIRED',
  'UNVERIFIABLE',
]);
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;
export const feeComponentSchema = z.strictObject({
  category: z.enum([
    'LP',
    'PROTOCOL',
    'CREATOR',
    'ROUTING',
    'INTEGRATOR',
    'TRANSFER',
    'NETWORK_BASE',
    'PRIORITY',
    'TIP',
    'ACCOUNT_CREATION',
  ]),
  asset: z.string(),
  amountUnits: units,
  decimals: z.number().int().min(0).max(18),
  usd: decimalSchema.nullable(),
  includedInQuote: z.boolean(),
});
export type FeeComponent = z.infer<typeof feeComponentSchema>;
export const executionAuditSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  orderId: idSchema,
  modelVersion: z.literal('SOLEMN_EXECUTION_V1'),
  context: executionContextSchema,
  signalId: idSchema.nullable().optional(),
  positionId: idSchema.optional(),
  executedAt: timestampSchema,
  outcome: executionOutcomeSchema,
  reason: z.string().nullable(),
  retryAllowed: z.boolean(),
  inputAsset: z.string(),
  outputAsset: z.string(),
  inputUnits: units,
  outputUnits: units,
  quotedInputUnits: units,
  quotedOutputUnits: units,
  effectivePriceUsd: decimalSchema.nullable(),
  impactBps: decimalSchema.nullable(),
  latencyMs: z.number().int().nonnegative(),
  fees: z.array(feeComponentSchema),
  feeUsd: decimalSchema,
  includedFeeUsd: decimalSchema,
  networkFeeUsd: decimalSchema,
  unpricedFeeLamports: units,
  updatedPool: poolSnapshotSchema.nullable(),
});
export type ExecutionAudit = z.infer<typeof executionAuditSchema>;
