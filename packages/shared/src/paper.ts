import {
  poolSnapshotSchema,
  nativeUsdSchema,
  executionContextSchema,
  executionAuditSchema,
  executionConfigSchema,
} from './execution.js';
import { z } from 'zod';
import { toAtomic } from './financial.js';
import {
  decimalSchema,
  positiveDecimalSchema,
  signedDecimalSchema,
  idSchema,
  mintAddressSchema,
  timestampSchema,
  orderSchema,
  orderRequestSchema,
  tradeSchema,
  orderStatusSchema,
} from './schemas/index.js';
import { percentageSchema, riskPolicySchema } from './risk.js';
import {
  buyCandidateSchema,
  marketDatasetSchema,
  strategyPolicySchema,
  strategyRiskContextSchema,
} from './market.js';

const percentBelow100 = percentageSchema.refine((value) => {
  if (!decimalSchema.safeParse(value).success) return false;
  const [whole] = value.split('.');
  return BigInt(whole!) < 100n;
}, 'Must be below 100');
export const paperPolicySchema = z
  .strictObject({
    version: z.literal('solemn-paper-v1'),
    initialBalanceUsd: positiveDecimalSchema,
    maxPositionPercent: percentageSchema,
    maxOpenPositions: z.number().int().min(1).max(100),
    stopLossPercent: percentBelow100,
    takeProfit1Percent: positiveDecimalSchema,
    takeProfit1Fraction: percentBelow100,
    takeProfit2Percent: positiveDecimalSchema,
    takeProfit2Fraction: percentBelow100,
    trailingStopPercent: percentBelow100,
    maxHoldingMinutes: z.number().int().positive().max(1440),
    maxDailyLossPercent: percentBelow100,
    maxTotalDrawdownPercent: percentBelow100,
    buyFeePercent: percentBelow100,
    sellFeePercent: percentBelow100,
    slippagePercent: percentBelow100,
    maxLiquidityParticipationPercent: percentBelow100,
    minimumOrderUsd: positiveDecimalSchema,
    quantityDecimals: z.number().int().min(0).max(18),
    maxPriceAgeSeconds: z.number().int().positive().max(300),
    maxSignalAgeSeconds: z.number().int().positive().max(300),
    entryCooldownSeconds: z.number().int().nonnegative().max(3600),
  })
  .superRefine((policy, context) => {
    if (
      !Object.values(policy)
        .filter(
          (value): value is string =>
            typeof value === 'string' && value !== 'solemn-paper-v1',
        )
        .every((value) => decimalSchema.safeParse(value).success)
    )
      return;
    for (const key of [
      'maxPositionPercent',
      'stopLossPercent',
      'takeProfit1Fraction',
      'takeProfit2Fraction',
      'trailingStopPercent',
      'maxDailyLossPercent',
      'maxTotalDrawdownPercent',
      'maxLiquidityParticipationPercent',
    ] as const)
      if (toAtomic(policy[key]) <= 0n)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Must be positive',
        });
    if (
      toAtomic(policy.takeProfit2Percent) <= toAtomic(policy.takeProfit1Percent)
    )
      context.addIssue({
        code: 'custom',
        path: ['takeProfit2Percent'],
        message: 'Second target must exceed the first',
      });
    if (
      toAtomic(policy.maxPositionPercent) * BigInt(policy.maxOpenPositions) >
      toAtomic('100')
    )
      context.addIssue({
        code: 'custom',
        path: ['maxPositionPercent'],
        message: 'Aggregate configured allocation exceeds the bankroll',
      });
    if (
      toAtomic(policy.minimumOrderUsd) >
      (toAtomic(policy.initialBalanceUsd) *
        toAtomic(policy.maxPositionPercent)) /
        toAtomic('100')
    )
      context.addIssue({
        code: 'custom',
        path: ['minimumOrderUsd'],
        message: 'Minimum order exceeds initial allocation',
      });
  });
export type PaperPolicy = z.infer<typeof paperPolicySchema>;
export const executionObservationSchema = z
  .strictObject({
    id: idSchema,
    mint: mintAddressSchema,
    poolAddress: mintAddressSchema,
    side: z.enum(['BUY', 'SELL']),
    observedAt: timestampSchema,
    receivedAt: timestampSchema,
    priceUsd: positiveDecimalSchema.nullable(),
    liquidityUsd: decimalSchema.nullable(),
    estimatedPriceImpactPercent: percentBelow100.nullable(),
    usdReliable: z.boolean(),
    healthy: z.boolean(),
    usdSource: z.string().min(1).max(128).nullable(),
    source: z.string().min(1).max(128),
    sourceTradeId: idSchema.nullable(),
    dataMode: z.literal('FIXTURE'),
    pool: poolSnapshotSchema.optional(),
    nativeUsd: nativeUsdSchema.nullable().optional(),
    simulationOutcome: z
      .enum(['FULL_FILL', 'TRANSACTION_FAILURE', 'PARTIAL_FILL'])
      .default('FULL_FILL'),
  })
  .refine(
    (value) => value.observedAt <= value.receivedAt,
    'Observation cannot arrive before its timestamp',
  );
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;
export const paperPositionSchema = z.strictObject({
  id: idSchema,
  portfolioId: idSchema,
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  status: z.enum(['OPEN', 'CLOSED', 'EXIT_BLOCKED']),
  signalId: idSchema,
  originalQuantity: positiveDecimalSchema,
  quantity: decimalSchema,
  entryPriceUsd: positiveDecimalSchema,
  initialCostBasisUsd: positiveDecimalSchema,
  costBasisUsd: decimalSchema,
  realizedPnlUsd: signedDecimalSchema,
  unrealizedPnlUsd: signedDecimalSchema,
  feesUsd: decimalSchema,
  openedAt: timestampSchema,
  closedAt: timestampSchema.nullable(),
  mark: executionObservationSchema.nullable(),
  markValueUsd: decimalSchema,
  valuationStale: z.boolean(),
  liquidationUncertain: z.boolean(),
  highestSellPriceUsd: positiveDecimalSchema.nullable(),
  trailingPeakUsd: positiveDecimalSchema.nullable(),
  target1Complete: z.boolean(),
  target2Complete: z.boolean(),
  blockedReason: z.string().nullable(),
  pendingExitReason: z.string().nullable(),
  pendingExitQuantity: decimalSchema.nullable(),
});
export type PaperPosition = z.infer<typeof paperPositionSchema>;
export const paperPortfolioStateSchema = z.strictObject({
  id: idSchema,
  asOf: timestampSchema,
  availableCashUsd: decimalSchema,
  reservedCashUsd: decimalSchema,
  investedCostBasisUsd: decimalSchema,
  positionValueUsd: decimalSchema,
  realizedPnlUsd: signedDecimalSchema,
  unrealizedPnlUsd: signedDecimalSchema,
  buyFeesUsd: decimalSchema,
  sellFeesUsd: decimalSchema,
  equityUsd: decimalSchema,
  peakEquityUsd: positiveDecimalSchema,
  drawdownPercent: decimalSchema,
  totalReturnPercent: signedDecimalSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayStartingEquityUsd: decimalSchema,
  dailyLossPercent: decimalSchema,
  status: z.enum(['ACTIVE', 'ENTRIES_BLOCKED', 'HALTED']),
  haltReason: z.string().nullable(),
  entryBlockReasons: z.array(z.string()),
  positions: z.array(paperPositionSchema).max(1000),
  executionUncertain: z.boolean().optional(),
});
export type PaperPortfolioState = z.infer<typeof paperPortfolioStateSchema>;
export const paperAccountDefinitionSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(100),
  mode: z.literal('PAPER'),
  currency: z.literal('USD'),
  dataMode: z.enum(['FIXTURE', 'FORWARD_REPLAY', 'FORWARD_LIVE']),
  forwardExecution: executionConfigSchema.optional(),
  strategyRunId: idSchema,
  replayHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: timestampSchema,
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: paperPolicySchema,
  strategyPolicy: strategyPolicySchema,
  riskPolicy: riskPolicySchema,
});
export type PaperAccountDefinition = z.infer<
  typeof paperAccountDefinitionSchema
>;
export const paperCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    execution: executionContextSchema.optional(),
    type: z.literal('ENTRY'),
    id: idSchema,
    at: timestampSchema,
    candidate: buyCandidateSchema,
    risk: strategyRiskContextSchema.nullable(),
    observation: executionObservationSchema.nullable(),
  }),
  z.strictObject({
    execution: executionContextSchema.optional(),
    type: z.literal('MARK'),
    id: idSchema,
    at: timestampSchema,
    observation: executionObservationSchema,
    risk: strategyRiskContextSchema.nullable(),
    deferExecution: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('FEED_UNAVAILABLE'),
    id: idSchema,
    at: timestampSchema,
    reason: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal('EXIT_UNAVAILABLE'),
    id: idSchema,
    at: timestampSchema,
    positionId: idSchema,
    reason: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal('TICK'),
    id: idSchema,
    at: timestampSchema,
  }),
  z.strictObject({
    type: z.literal('HALT'),
    id: idSchema,
    at: timestampSchema,
    reason: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal('RESET_HALT'),
    id: idSchema,
    at: timestampSchema,
    reason: z.string().min(1).max(256),
  }),
]);
export type PaperCommand = z.infer<typeof paperCommandSchema>;
export const paperPostingSchema = z.strictObject({
  type: z.enum([
    'EXECUTION_FEE',
    'INITIAL_BALANCE',
    'RESERVE',
    'RELEASE',
    'BUY_FILL',
    'SELL_FILL',
  ]),
  availableDeltaUsd: signedDecimalSchema,
  reservedDeltaUsd: signedDecimalSchema,
  realizedDeltaUsd: signedDecimalSchema,
  buyFeesDeltaUsd: decimalSchema,
  sellFeesDeltaUsd: decimalSchema,
});
export type PaperPosting = z.infer<typeof paperPostingSchema>;
export const paperOrderRecordSchema = z.strictObject({
  audit: executionAuditSchema.optional(),
  order: orderSchema,
  trades: z.array(tradeSchema).max(1),
  request: orderRequestSchema,
  positionId: idSchema,
  signalId: idSchema.nullable(),
  reason: z.string(),
  observation: executionObservationSchema.nullable(),
  assumptions: paperPolicySchema,
  failureReason: z.string().nullable(),
  lifecycle: z.array(orderStatusSchema),
  notionalUsd: decimalSchema,
  slippageUsd: decimalSchema,
});
export type PaperOrderRecord = z.infer<typeof paperOrderRecordSchema>;
export const paperActionResultSchema = z.strictObject({
  outcome: z.enum([
    'ENTRY_FILLED',
    'ENTRY_REJECTED',
    'EXIT_FILLED',
    'EXIT_SCHEDULED',
    'EXIT_FAILED',
    'MARK_UPDATED',
    'STALE_DATA',
    'NO_POSITION',
    'RESET',
    'HALTED',
  ]),
  reasons: z.array(z.string()),
  orderId: idSchema.nullable(),
  positionId: idSchema.nullable(),
});
export type PaperActionResult = z.infer<typeof paperActionResultSchema>;
export interface PaperTransition {
  state: PaperPortfolioState;
  postings: PaperPosting[];
  orders: PaperOrderRecord[];
  result: PaperActionResult;
}
export const paperReplaySchema = z
  .strictObject({
    format: z.literal('SOLEMN_PAPER_REPLAY_V1'),
    name: z.string().min(1).max(100),
    marketDataset: marketDatasetSchema,
    observations: z.array(executionObservationSchema).min(1).max(1000),
  })
  .refine(
    (value) =>
      new Set(value.observations.map((item) => item.id)).size ===
      value.observations.length,
    'Duplicate execution observation identity',
  );
export type PaperReplay = z.infer<typeof paperReplaySchema>;
