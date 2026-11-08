import { z } from 'zod';
import {
  idSchema,
  timestampSchema,
  mintAddressSchema,
  decimalSchema,
  signedDecimalSchema,
} from './schemas/index.js';
import {
  marketTradeSchema,
  coverageSchema,
  strategyRiskContextSchema,
  strategyPolicySchema,
} from './market.js';
import { executionObservationSchema, paperPolicySchema } from './paper.js';
import type { paperPortfolioStateSchema } from './paper.js';
import { riskPolicySchema } from './risk.js';
import { stableId } from './identity.js';

export const historicalMarketSchema = z.strictObject({
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  quoteMint: mintAddressSchema,
  poolCreatedAt: timestampSchema.nullable(),
  poolCreationAvailableAt: timestampSchema.nullable(),
});
export type HistoricalMarket = z.infer<typeof historicalMarketSchema>;
export const historicalManifestSchema = z
  .strictObject({
    format: z.literal('SOLEMN_HISTORY_V1'),
    datasetId: z.string().min(1).max(128),
    version: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    sourceKind: z.enum(['SYNTHETIC', 'HISTORICAL']),
    provenance: z.string().min(1).max(2000),
    startTime: timestampSchema,
    endTime: timestampSchema,
    orderingPolicy: z.literal('AVAILABILITY_V1'),
    markets: z.array(historicalMarketSchema).min(1).max(100),
  })
  .refine(
    (value) =>
      Date.parse(value.endTime) > Date.parse(value.startTime) &&
      Date.parse(value.endTime) - Date.parse(value.startTime) <= 90 * 86400000,
    'History must span a positive interval of at most 90 days',
  )
  .refine(
    (value) =>
      Date.parse(value.startTime) % 60000 === 0 &&
      Date.parse(value.endTime) % 60000 === 0,
    'Dataset boundaries must align to UTC minutes',
  )
  .refine(
    (value) =>
      new Set(
        value.markets.map((market) => `${market.mint}:${market.poolAddress}`),
      ).size === value.markets.length,
    'Duplicate historical markets',
  );
export type HistoricalManifest = z.infer<typeof historicalManifestSchema>;
const envelope = {
  id: idSchema,
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  eventAt: timestampSchema.nullable(),
  availableAt: timestampSchema,
  slot: z
    .string()
    .regex(/^(0|[1-9]\d{0,19})$/)
    .nullable()
    .default(null),
  transactionIndex: z
    .number()
    .int()
    .nonnegative()
    .max(2147483647)
    .nullable()
    .default(null),
  providerIndex: z
    .number()
    .int()
    .nonnegative()
    .max(2147483647)
    .nullable()
    .default(null),
  source: z.string().min(1).max(128),
};
export const historicalEventSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...envelope,
      kind: z.literal('TRADE'),
      data: marketTradeSchema,
    }),
    z.strictObject({
      ...envelope,
      kind: z.literal('COVERAGE'),
      data: coverageSchema,
    }),
    z.strictObject({
      ...envelope,
      kind: z.literal('RISK'),
      data: strategyRiskContextSchema,
    }),
    z.strictObject({
      ...envelope,
      kind: z.literal('EXECUTION'),
      data: executionObservationSchema,
    }),
    z.strictObject({
      ...envelope,
      kind: z.literal('DISCOVERY'),
      data: z.strictObject({
        sourceEventId: z.string().min(1).max(512),
        eventType: z.enum(['TOKEN_CREATED', 'TOKEN_MIGRATED']),
        rawPayload: z.record(z.string(), z.json()),
      }),
    }),
    z.strictObject({
      ...envelope,
      kind: z.literal('UNKNOWN'),
      data: z.record(z.string(), z.json()),
    }),
  ])
  .superRefine((event, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: 'custom', message });
    for (const time of [event.availableAt, event.eventAt])
      if (time && /\.\d{4,}Z$/.test(time))
        fail(
          'Historical clock precision is milliseconds; sub-millisecond timestamps are unsupported',
        );
    if (
      event.eventAt &&
      Date.parse(event.eventAt) > Date.parse(event.availableAt)
    )
      fail('Historical event cannot be known before it occurs');
    if (event.kind === 'TRADE' || event.kind === 'EXECUTION') {
      if (
        event.data.mint !== event.mint ||
        event.data.poolAddress !== event.poolAddress
      )
        fail('Historical market scope mismatch');
      if (Date.parse(event.data.receivedAt) !== Date.parse(event.availableAt))
        fail('Receipt time must represent historical information availability');
    }
    if (
      event.kind === 'TRADE' &&
      (event.eventAt === null ||
        Date.parse(event.eventAt) !== Date.parse(event.data.timestamp))
    )
      fail('Trade event time is required and must match its payload');
    if (
      event.kind === 'EXECUTION' &&
      (event.eventAt === null ||
        Date.parse(event.eventAt) !== Date.parse(event.data.observedAt))
    )
      fail('Execution observation time is required');
    if (
      event.kind === 'COVERAGE' &&
      (Date.parse(event.data.end) - Date.parse(event.data.start) !== 60000 ||
        Date.parse(event.data.start) % 60000 !== 0)
    )
      fail('Historical coverage must describe one UTC minute');
    if (
      event.kind === 'COVERAGE' &&
      Date.parse(event.data.availableAt) !== Date.parse(event.availableAt)
    )
      fail('Coverage availability mismatch');
    if (
      event.kind === 'RISK' &&
      (Date.parse(event.data.availableAt) !== Date.parse(event.availableAt) ||
        (event.data.assessment !== null &&
          event.data.assessment.tokenMint !== event.mint))
    )
      fail('Historical risk scope/availability mismatch');
  });
export type HistoricalEvent = z.infer<typeof historicalEventSchema>;
export const eventPriority = {
  RISK: 0,
  COVERAGE: 1,
  TRADE: 2,
  EXECUTION: 3,
  DISCOVERY: 4,
  UNKNOWN: 5,
} as const;
export function historicalSortKey(event: HistoricalEvent): string {
  const iso = (value: string) => new Date(value).toISOString();
  return [
    iso(event.availableAt),
    iso(event.eventAt ?? event.availableAt),
    eventPriority[event.kind],
    event.slot?.padStart(20, '0') ?? '~',
    event.transactionIndex?.toString().padStart(10, '0') ?? '~',
    event.providerIndex?.toString().padStart(10, '0') ?? '~',
    event.id,
  ].join('|');
}
export const compareHistoricalEvents = (
  left: HistoricalEvent,
  right: HistoricalEvent,
) => {
  const a = historicalSortKey(left),
    b = historicalSortKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
export const historyIdentity = (
  kind: HistoricalEvent['kind'],
  mint: string,
  pool: string,
  sourceId: string,
) => stableId(['solemn-history-v1', kind, mint, pool, sourceId]);
export const historicalFileSchema = z.strictObject({
  manifest: historicalManifestSchema,
  events: z.array(historicalEventSchema).max(100000),
});
export type HistoricalFile = z.infer<typeof historicalFileSchema>;
export const datasetQualitySchema = z.strictObject({
  totalTokens: z.number().int().nonnegative(),
  totalEvents: z.number().int().nonnegative(),
  totalTrades: z.number().int().nonnegative(),
  executionObservations: z.number().int().nonnegative(),
  earliestObservation: timestampSchema.nullable(),
  latestObservation: timestampSchema.nullable(),
  missingTimestamps: z.number().int().nonnegative(),
  duplicateEvents: z.number().int().nonnegative(),
  marketDataGaps: z.number().int().nonnegative(),
  missingPriceObservations: z.number().int().nonnegative(),
  missingLiquidityInformation: z.number().int().nonnegative(),
  missingHistoricalSecurityAssessments: z.number().int().nonnegative(),
  tokensWithInsufficientStrategyHistory: z.number().int().nonnegative(),
  unknownSourceEvents: z.number().int().nonnegative(),
  uncertainOrderingGroups: z.number().int().nonnegative(),
  missingHistoricalIntervals: z.number().int().nonnegative(),
  readiness: z.enum(['READY_WITH_LIMITATIONS', 'INSUFFICIENT']),
  limitations: z.array(z.string()),
});
export type DatasetQuality = z.infer<typeof datasetQualitySchema>;
export const storedDatasetSchema = z.strictObject({
  id: idSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: historicalManifestSchema,
  quality: datasetQualitySchema,
});
export type StoredDataset = z.infer<typeof storedDatasetSchema>;
export const backtestOptionsSchema = z.strictObject({
  dataset: z.string().min(1),
  startTime: timestampSchema.optional(),
  endTime: timestampSchema.optional(),
  initialBalanceUsd: decimalSchema.optional(),
  strategyId: z
    .literal('SOLEMN_LAUNCH_MOMENTUM_V1')
    .default('SOLEMN_LAUNCH_MOMENTUM_V1'),
  runId: idSchema.optional(),
  executionLatencyMs: z.number().int().min(0).max(60000).default(1000),
  executionWaitMs: z.number().int().min(1).max(3600000).default(30000),
  equityCadenceMs: z.number().int().min(1000).max(600000).default(60000),
  batchSize: z.number().int().min(1).max(1000).default(1000),
  maxEvents: z.number().int().min(1).max(1000000).default(1000000),
  outputDirectory: z.string().min(1).max(4096).default('reports/backtests'),
  strategy: strategyPolicySchema.optional(),
  paper: paperPolicySchema.optional(),
  risk: riskPolicySchema.optional(),
  verbose: z.boolean().default(false),
  tradingMode: z.literal('PAPER').default('PAPER'),
});
export type BacktestOptions = z.infer<typeof backtestOptionsSchema>;
export const backtestPlanSchema = z
  .strictObject({
    version: z.literal('solemn-backtest-v1'),
    runId: idSchema,
    portfolioId: idSchema,
    strategyRunId: idSchema,
    datasetId: idSchema,
    datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceKind: z.enum(['SYNTHETIC', 'HISTORICAL']),
    startTime: timestampSchema,
    endTime: timestampSchema,
    tradingMode: z.literal('PAPER'),
    executionLatencyMs: z.number().int().nonnegative(),
    executionWaitMs: z.number().int().positive(),
    equityCadenceMs: z.number().int().positive(),
    batchSize: z.number().int().positive(),
    maxEvents: z.number().int().positive(),
    strategy: strategyPolicySchema,
    paper: paperPolicySchema,
    risk: riskPolicySchema,
  })
  .refine(
    (plan) => Date.parse(plan.endTime) > Date.parse(plan.startTime),
    'Invalid backtest date range',
  );
export type BacktestPlan = z.infer<typeof backtestPlanSchema>;
export const equitySnapshotSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  timestamp: timestampSchema,
  availableCashUsd: decimalSchema,
  reservedCashUsd: decimalSchema,
  markedPositionsUsd: decimalSchema.nullable(),
  totalEquityUsd: decimalSchema.nullable(),
  realizedPnlUsd: signedDecimalSchema,
  unrealizedPnlUsd: signedDecimalSchema.nullable(),
  drawdownPercent: decimalSchema.nullable(),
  valuationQuality: z.enum(['RELIABLE', 'UNCERTAIN']),
  reasons: z.array(z.string()),
});
export type EquitySnapshot = z.infer<typeof equitySnapshotSchema>;
export const executionIntentSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  kind: z.enum(['ENTRY', 'EXIT']),
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  signalId: idSchema.nullable(),
  positionId: idSchema.nullable(),
  triggerAt: timestampSchema,
  dueAt: timestampSchema,
  expiresAt: timestampSchema,
  reason: z.string(),
  status: z.enum([
    'PENDING',
    'FILLED',
    'FAILED',
    'EXPIRED',
    'UNFILLED',
    'SUPERSEDED',
  ]),
  attemptedAt: timestampSchema.nullable(),
  observationId: idSchema.nullable(),
  orderId: idSchema.nullable(),
  reasons: z.array(z.string()),
});
export type ExecutionIntent = z.infer<typeof executionIntentSchema>;
export type BacktestMetrics = {
  portfolio: {
    startingBalanceUsd: string;
    endingCashUsd: string;
    endingMarkedEquityUsd: string | null;
    realizedNetPnlUsd: string;
    unrealizedPnlUsd: string | null;
    totalNetReturnPercent: string | null;
    peakReliableEquityUsd: string;
    maximumDrawdownPercent: string;
    drawdownCoverageComplete: boolean;
    buyFeesUsd: string;
    sellFeesUsd: string;
    totalFeesUsd: string;
    simulatedSlippageUsd: string;
  };
  trading: {
    entryOrders: number;
    exitOrders: number;
    filledOrders: number;
    failedOrders: number;
    closedPositions: number;
    winningClosedPositions: number;
    losingClosedPositions: number;
    breakEvenClosedPositions: number;
    winRatePercent: string | null;
    averageWinningReturnPercent: string | null;
    averageLosingReturnPercent: string | null;
    averageWinningPnlUsd: string | null;
    averageLosingPnlUsd: string | null;
    expectancyUsd: string | null;
    medianPositionReturnPercent: string | null;
    largestWinningPositionUsd: string | null;
    largestLosingPositionUsd: string | null;
    profitFactor: { value: string | null; reason: string | null };
    averageHoldingSeconds: string | null;
    maximumConcurrentPositions: number;
  };
  strategy: {
    tokensEvaluated: number;
    evaluations: number;
    tokensBlockedByRisk: number;
    riskBlockedDecisions: number;
    signalsGenerated: number;
    entriesRejected: number;
    signalsRejectedByPortfolioRisk: number;
    signalsWithoutExecutionObservations: number;
    positionsOpened: number;
    positionsClosed: number;
    positionsRemainingOpen: number;
    stopLossExits: number;
    takeProfitExits: number;
    trailingStopExits: number;
    timeBasedExits: number;
    failedExitAttempts: number;
  };
  dataQuality: {
    missingHistoricalIntervals: number;
    stalePriceObservations: number;
    unknownSecurityAssessments: number;
    insufficientHistoryDecisions: number;
    unpricedOpenPositions: number;
    executionObservationsUnavailable: number;
    uncertainEquitySnapshots: number;
  };
  baseline: {
    startingBalanceUsd: string;
    endingEquityUsd: string;
    netReturnPercent: '0';
    feesUsd: '0';
    trades: 0;
    strategyMinusBaselineUsd: string | null;
  };
};
export interface BacktestResult {
  plan: BacktestPlan;
  dataset: StoredDataset;
  runDataQuality: DatasetQuality;
  metrics: BacktestMetrics;
  finalState: z.infer<typeof paperPortfolioStateSchema>;
  eventsProcessed: number;
  signals: number;
  limitations: string[];
}
