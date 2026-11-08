import { z } from 'zod';
import {
  decimalSchema,
  idSchema,
  mintAddressSchema,
  positiveDecimalSchema,
  riskStatusSchema,
  signatureSchema,
  timestampSchema,
} from './schemas/index.js';
import { percentageSchema, tokenRiskAssessmentSchema } from './risk.js';
import { stableId } from './identity.js';

export const marketTradeSchema = z
  .strictObject({
    id: idSchema,
    mint: mintAddressSchema,
    poolAddress: mintAddressSchema.nullable(),
    timestamp: timestampSchema,
    receivedAt: timestampSchema,
    side: z.enum(['BUY', 'SELL', 'UNKNOWN']),
    tokenAmount: positiveDecimalSchema,
    quoteAmount: positiveDecimalSchema,
    quoteMint: mintAddressSchema.nullable(),
    priceUsd: positiveDecimalSchema.nullable(),
    volumeUsd: decimalSchema.nullable(),
    usdReliable: z.boolean(),
    usdSource: z.string().min(1).max(128).nullable(),
    usdObservedAt: timestampSchema.nullable(),
    traderAddress: mintAddressSchema.nullable(),
    transactionSignature: signatureSchema.nullable(),
    source: z.string().min(1).max(128),
    sourceEventId: z.string().min(1).max(512),
    rawPayload: z.record(z.string(), z.json()),
  })
  .refine(
    (trade) =>
      trade.id ===
      stableId(['market-trade', trade.source, trade.sourceEventId]),
    'Trade ID must derive from source event identity',
  )
  .refine(
    (trade) => Date.parse(trade.timestamp) <= Date.parse(trade.receivedAt),
    'Trade cannot be received before it occurs',
  );
export type NormalizedMarketTrade = z.infer<typeof marketTradeSchema>;

export const coverageSchema = z
  .strictObject({
    id: idSchema,
    start: timestampSchema,
    end: timestampSchema,
    availableAt: timestampSchema,
    kind: z.enum(['OBSERVED', 'GAP']),
    reason: z.string().nullable(),
  })
  .refine(
    (item) =>
      Date.parse(item.start) < Date.parse(item.end) &&
      Date.parse(item.end) <= Date.parse(item.availableAt),
    'Coverage must be observed after the interval ends',
  );
export type MarketCoverage = z.infer<typeof coverageSchema>;
export const strategyRiskContextSchema = z
  .strictObject({
    currentStatus: riskStatusSchema,
    currentRequestId: idSchema.nullable(),
    assessment: tokenRiskAssessmentSchema.nullable(),
    availableAt: timestampSchema,
  })
  .refine(
    (value) =>
      value.assessment === null ||
      Date.parse(value.assessment.assessedAt) <= Date.parse(value.availableAt),
    'Risk observation cannot predate its assessment',
  );
export type StrategyRiskContext = z.infer<typeof strategyRiskContextSchema>;

export const fixtureMarketSchema = z.strictObject({
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  quoteMint: mintAddressSchema,
  poolCreatedAt: timestampSchema.nullable(),
  trades: z.array(marketTradeSchema).max(20000),
  coverage: z.array(coverageSchema).max(500),
  risks: z.array(strategyRiskContextSchema).max(500),
});
export const marketDatasetSchema = z
  .strictObject({
    format: z.literal('SOLEMN_MARKET_REPLAY_V1'),
    name: z.string().min(1).max(128),
    start: timestampSchema,
    end: timestampSchema,
    markets: z.array(fixtureMarketSchema).min(1).max(100),
  })
  .refine(
    (value) =>
      Date.parse(value.end) > Date.parse(value.start) &&
      Date.parse(value.end) - Date.parse(value.start) <= 120 * 60000,
    'Replay duration must be positive and at most 120 minutes',
  )
  .refine(
    (value) =>
      Date.parse(value.start) % 60000 === 0 &&
      Date.parse(value.end) % 60000 === 0,
    'Replay boundaries must align to UTC minutes',
  )
  .refine(
    (value) =>
      new Set(
        value.markets.map((market) => `${market.mint}:${market.poolAddress}`),
      ).size === value.markets.length,
    'Duplicate replay markets',
  );
export type MarketDataset = z.infer<typeof marketDatasetSchema>;
export type FixtureMarket = z.infer<typeof fixtureMarketSchema>;

export const marketCandleSchema = z.strictObject({
  id: idSchema,
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  startTime: timestampSchema,
  endTime: timestampSchema,
  finalizedAt: timestampSchema,
  open: positiveDecimalSchema.nullable(),
  high: positiveDecimalSchema.nullable(),
  low: positiveDecimalSchema.nullable(),
  close: positiveDecimalSchema.nullable(),
  volumeUsd: decimalSchema.nullable(),
  buyVolumeUsd: decimalSchema.nullable(),
  sellVolumeUsd: decimalSchema.nullable(),
  tradeCount: z.number().int().nonnegative(),
  uniqueBuyers: z.number().int().nonnegative().nullable(),
  buyers: z.array(mintAddressSchema).nullable(),
  complete: z.boolean(),
  issues: z.array(z.string()),
  tradeIds: z.array(idSchema),
});
export type MarketCandle = z.infer<typeof marketCandleSchema>;

const ratioDecimal = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,511})(?:\.\d{1,18})?$/);
export const ratioSchema = z.strictObject({
  state: z.enum(['AVAILABLE', 'UNAVAILABLE', 'ZERO_DENOMINATOR']),
  numerator: ratioDecimal.nullable(),
  denominator: ratioDecimal.nullable(),
  value: ratioDecimal.nullable(),
  reason: z.string().nullable(),
});
export type Ratio = z.infer<typeof ratioSchema>;
export const momentumFeaturesSchema = z.strictObject({
  momentum1m: ratioSchema,
  momentum5m: ratioSchema,
  momentum15m: ratioSchema,
  volumeAcceleration: ratioSchema,
  buySellRatio: ratioSchema,
  volatility5m: ratioSchema,
  volume5mUsd: decimalSchema.nullable(),
  buyVolume5mUsd: decimalSchema.nullable(),
  sellVolume5mUsd: decimalSchema.nullable(),
  uniqueBuyers5m: z.number().int().nonnegative().nullable(),
  candleIds: z.array(idSchema),
});
export type MomentumFeatures = z.infer<typeof momentumFeaturesSchema>;

export const strategyPolicySchema = z.strictObject({
  strategyId: z.literal('SOLEMN_LAUNCH_MOMENTUM_V1'),
  version: z.string().min(1).max(100),
  minPoolAgeMinutes: z.number().int().nonnegative(),
  maxPoolAgeMinutes: z.number().int().positive(),
  minLiquidityUsd: positiveDecimalSchema,
  minVolumeAcceleration: positiveDecimalSchema,
  minBuySellRatio: positiveDecimalSchema,
  minUniqueBuyers5m: z.number().int().positive(),
  breakoutLookbackCandles: z.number().int().positive().max(15),
  breakoutBufferPercentage: percentageSchema,
  minPullbackPercentage: percentageSchema,
  minInitialSpikePercentage: percentageSchema,
  maxVolatilityPercentage: percentageSchema,
  patternMaxAgeSeconds: z.number().int().positive(),
  cooldownSeconds: z.number().int().nonnegative(),
  maxRiskAgeSeconds: z.number().int().positive(),
  maxMarketAgeSeconds: z.number().int().positive(),
  allowedLatenessMs: z.number().int().nonnegative().max(30000),
});
export type StrategyPolicy = z.infer<typeof strategyPolicySchema>;

export const breakoutStateSchema = z.strictObject({
  stage: z.enum([
    'WAITING_FOR_HISTORY',
    'OBSERVING_MOMENTUM',
    'INITIAL_SPIKE_DETECTED',
    'PULLBACK_CONFIRMED',
    'BREAKOUT_CONFIRMED',
    'BUY_CANDIDATE',
  ]),
  spikeCandleId: idSchema.nullable(),
  spikeAt: timestampSchema.nullable(),
  resistance: positiveDecimalSchema.nullable(),
  pullbackCandleId: idSchema.nullable(),
  pullbackLow: positiveDecimalSchema.nullable(),
});
export type BreakoutState = z.infer<typeof breakoutStateSchema>;
export const strategyStateSchema = z.strictObject({
  breakout: breakoutStateSchema,
  lastSignalAt: timestampSchema.nullable(),
});
export type StrategyState = z.infer<typeof strategyStateSchema>;
export const marketCorrectionSchema = z.strictObject({
  id: idSchema,
  tradeId: idSchema,
  receivedAt: timestampSchema,
  candleStart: timestampSchema,
  reason: z.enum(['LATE_TRADE', 'CONFLICTING_TRADE', 'WRONG_MARKET']),
  trade: marketTradeSchema,
});
export type MarketCorrection = z.infer<typeof marketCorrectionSchema>;

export const buyCandidateSchema = z.strictObject({
  id: idSchema,
  dataMode: z.literal('FIXTURE'),
  mint: mintAddressSchema,
  poolAddress: mintAddressSchema,
  strategyId: z.literal('SOLEMN_LAUNCH_MOMENTUM_V1'),
  strategyVersion: z.string(),
  configHash: z.string(),
  timestamp: timestampSchema,
  candleEnd: timestampSchema,
  referencePriceUsd: positiveDecimalSchema,
  liquidityUsd: positiveDecimalSchema,
  features: momentumFeaturesSchema,
  breakoutReference: positiveDecimalSchema,
  riskAssessmentId: idSchema,
  opportunityKey: z.string(),
  explanation: z.string(),
  reasons: z.array(z.string()),
  sourceRefs: z.array(z.string()),
});
export type BuyCandidate = z.infer<typeof buyCandidateSchema>;
export const strategyDecisionSchema = z
  .strictObject({
    id: idSchema,
    runId: idSchema,
    mint: mintAddressSchema,
    poolAddress: mintAddressSchema.nullable(),
    timestamp: timestampSchema,
    candleId: idSchema.nullable(),
    outcome: z.enum([
      'BUY_CANDIDATE',
      'NO_SIGNAL',
      'INSUFFICIENT_DATA',
      'BLOCKED_BY_RISK',
    ]),
    reasons: z.array(z.string()).min(1),
    explanation: z.string(),
    features: momentumFeaturesSchema.nullable(),
    stateBefore: strategyStateSchema,
    stateAfter: strategyStateSchema,
    transitions: z.array(z.string()),
    risk: strategyRiskContextSchema.nullable(),
    sourceRefs: z.array(z.string()),
    candidate: buyCandidateSchema.nullable(),
  })
  .refine(
    (decision) =>
      (decision.outcome === 'BUY_CANDIDATE') === (decision.candidate !== null),
    'Only BUY candidates contain a candidate payload',
  );
export type StrategyDecision = z.infer<typeof strategyDecisionSchema>;
