import {
  stableHash,
  stableId,
  strategyDecisionSchema,
  toAtomic,
} from '@solemn/shared';
import type {
  MarketCandle,
  MarketCorrection,
  StrategyDecision,
  StrategyPolicy,
  StrategyRiskContext,
  StrategyState,
} from '@solemn/shared';
import type { Config } from '../config/index.js';
import {
  evaluateTokenRisk,
  policyHash,
  riskPolicy,
} from '../risk/tokenRiskEngine.js';
import { analyzeMomentum } from '../analysis/momentumAnalyzer.js';
import { emptyBreakout, detectBreakout } from './breakoutDetector.js';
import { ratioAtLeast, ratioAtMost, ratioPositive } from './exactMath.js';

export function strategyPolicy(config: Config): StrategyPolicy {
  return {
    strategyId: config.STRATEGY_ID,
    version: config.STRATEGY_VERSION,
    minPoolAgeMinutes: config.STRATEGY_MIN_POOL_AGE_MINUTES,
    maxPoolAgeMinutes: config.STRATEGY_MAX_POOL_AGE_MINUTES,
    minLiquidityUsd: config.STRATEGY_MIN_LIQUIDITY_USD,
    minVolumeAcceleration: config.STRATEGY_MIN_VOLUME_ACCELERATION,
    minBuySellRatio: config.STRATEGY_MIN_BUY_SELL_RATIO,
    minUniqueBuyers5m: config.STRATEGY_MIN_UNIQUE_BUYERS_5M,
    breakoutLookbackCandles: config.STRATEGY_BREAKOUT_LOOKBACK_CANDLES,
    breakoutBufferPercentage: config.STRATEGY_BREAKOUT_BUFFER_PERCENT,
    minPullbackPercentage: config.STRATEGY_MIN_PULLBACK_PERCENT,
    minInitialSpikePercentage: config.STRATEGY_MIN_INITIAL_SPIKE_PERCENT,
    maxVolatilityPercentage: config.STRATEGY_MAX_VOLATILITY_PERCENT,
    patternMaxAgeSeconds: config.STRATEGY_PATTERN_MAX_AGE_SECONDS,
    cooldownSeconds: config.STRATEGY_SIGNAL_COOLDOWN_SECONDS,
    maxRiskAgeSeconds: config.STRATEGY_MAX_RISK_ASSESSMENT_AGE_SECONDS,
    maxMarketAgeSeconds: config.STRATEGY_MAX_MARKET_DATA_AGE_SECONDS,
    allowedLatenessMs: config.MARKET_DATA_ALLOWED_LATENESS_MS,
  };
}
export const initialStrategyState = (): StrategyState => ({
  breakout: emptyBreakout(),
  lastSignalAt: null,
});
export interface SignalEvaluation {
  runId: string;
  mint: string;
  poolAddress: string;
  poolCreatedAt: string | null;
  asOf: string;
  candleEnd: string;
  candles: readonly MarketCandle[];
  risk: StrategyRiskContext | null;
  feedHealthy: boolean;
  lastMarketUpdateAt: string | null;
  corrections: readonly MarketCorrection[];
  sourceRefs: string[];
}

export function evaluateSignal(
  input: SignalEvaluation,
  previous: StrategyState,
  config: Config,
): StrategyDecision {
  const policy = strategyPolicy(config),
    hash = stableHash(policy),
    now = Date.parse(input.asOf);
  const candles = input.candles
    .filter(
      (candle) =>
        Date.parse(candle.endTime) <= Date.parse(input.candleEnd) &&
        Date.parse(candle.finalizedAt) <= now,
    )
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const current = candles
    .filter((candle) => candle.endTime === input.candleEnd)
    .at(-1);
  const features = analyzeMomentum(candles, input.candleEnd);
  const risk = input.risk;
  const expectedRiskPolicy = riskPolicy(config);
  const state = structuredClone(previous);
  const result = (
    outcome: StrategyDecision['outcome'],
    reasons: string[],
    transitions: string[] = [],
    candidate: StrategyDecision['candidate'] = null,
  ) =>
    strategyDecisionSchema.parse({
      id: stableId([
        'decision-v1',
        input.runId,
        input.mint,
        input.poolAddress,
        input.candleEnd,
        input.asOf,
      ]),
      runId: input.runId,
      mint: input.mint,
      poolAddress: input.poolAddress,
      timestamp: input.asOf,
      candleId: current?.id ?? null,
      outcome,
      reasons,
      explanation: reasons.join('; '),
      features,
      stateBefore: previous,
      stateAfter: state,
      transitions,
      risk,
      sourceRefs: input.sourceRefs,
      candidate,
    });
  const block = (
    outcome: 'BLOCKED_BY_RISK' | 'INSUFFICIENT_DATA',
    reasons: string[],
  ) => {
    const transition = `${state.breakout.stage}->WAITING_FOR_HISTORY`;
    state.breakout = emptyBreakout();
    return result(outcome, [...new Set(reasons)], [transition]);
  };
  const assessment = risk?.assessment;
  if (!risk || !assessment)
    return block('BLOCKED_BY_RISK', ['RISK_ASSESSMENT_MISSING']);
  if (risk.currentStatus !== 'ELIGIBLE' || assessment.status !== 'ELIGIBLE')
    return block('BLOCKED_BY_RISK', ['RISK_NOT_ELIGIBLE']);
  if (
    risk.currentRequestId !== assessment.requestId ||
    assessment.tokenMint !== input.mint
  )
    return block('BLOCKED_BY_RISK', ['RISK_NOT_CURRENT']);
  if (
    Date.parse(risk.availableAt) > now ||
    Date.parse(assessment.assessedAt) > now
  )
    return block('BLOCKED_BY_RISK', ['RISK_OBSERVATION_IN_FUTURE']);
  if (
    !assessment.validUntil ||
    Date.parse(assessment.validUntil) <= now ||
    now - Date.parse(assessment.assessedAt) >= policy.maxRiskAgeSeconds * 1000
  )
    return block('BLOCKED_BY_RISK', ['RISK_ASSESSMENT_STALE']);
  if (assessment.policyHash !== policyHash(expectedRiskPolicy))
    return block('BLOCKED_BY_RISK', ['RISK_POLICY_MISMATCH']);
  const revalidated = evaluateTokenRisk(
    {
      tokenMint: input.mint,
      requestId: assessment.requestId,
      requestedAt: assessment.requestedAt,
      attempt: assessment.attempt,
      trigger: 'STRATEGY_GATE',
      previous: null,
    },
    assessment.evidence.jupiter,
    assessment.evidence.solana,
    expectedRiskPolicy,
    input.asOf,
  );
  if (revalidated.status !== 'ELIGIBLE')
    return block('BLOCKED_BY_RISK', [
      'RISK_REVALIDATION_FAILED',
      ...revalidated.reasons,
    ]);
  const missing: string[] = [];
  if (
    candles.some(
      (candle) =>
        candle.mint !== input.mint || candle.poolAddress !== input.poolAddress,
    )
  )
    missing.push('INCOMPATIBLE_POOL_DATA');
  if (!input.feedHealthy) missing.push('FEED_DISCONNECTED');
  if (
    input.lastMarketUpdateAt === null ||
    now - Date.parse(input.lastMarketUpdateAt) >
      policy.maxMarketAgeSeconds * 1000 ||
    Date.parse(input.lastMarketUpdateAt) > now
  )
    missing.push('MARKET_DATA_STALE');
  if (!current || candles.length < 10 || current.endTime !== input.candleEnd)
    missing.push('CANDLE_HISTORY_INSUFFICIENT');
  if (
    candles
      .slice(-10)
      .some((candle) => !candle.complete || candle.issues.length > 0)
  )
    missing.push('CANDLE_DATA_INCOMPLETE');
  if (
    input.corrections.some(
      (correction) =>
        Date.parse(correction.receivedAt) <= now &&
        Date.parse(correction.candleStart) >=
          Date.parse(input.candleEnd) - 16 * 60000,
    )
  )
    missing.push('MARKET_CORRECTION_PENDING');
  if (input.poolCreatedAt === null) missing.push('POOL_CREATED_AT_UNKNOWN');
  for (const [name, indicator] of [
    ['PRICE_MOMENTUM_1M', features.momentum1m],
    ['PRICE_MOMENTUM_5M', features.momentum5m],
    ['VOLUME_ACCELERATION', features.volumeAcceleration],
    ['BUY_SELL_RATIO', features.buySellRatio],
    ['VOLATILITY', features.volatility5m],
  ] as const) {
    if (indicator.state !== 'AVAILABLE')
      missing.push(`${name}_${indicator.state}`);
  }
  if (features.uniqueBuyers5m === null)
    missing.push('BUYER_IDENTITIES_UNAVAILABLE');
  if (missing.length) return block('INSUFFICIENT_DATA', missing);
  const ageMinutes =
    (Date.parse(input.candleEnd) - Date.parse(input.poolCreatedAt as string)) /
    60000; // Time only, not a financial value.
  const liquidity = assessment.checks.liquidityUsd;
  if (
    ageMinutes < policy.minPoolAgeMinutes ||
    ageMinutes > policy.maxPoolAgeMinutes
  ) {
    state.breakout = emptyBreakout();
    return result('NO_SIGNAL', ['POOL_AGE_OUT_OF_RANGE']);
  }
  if (
    liquidity === null ||
    toAtomic(liquidity) < toAtomic(policy.minLiquidityUsd)
  ) {
    state.breakout = emptyBreakout();
    return result('NO_SIGNAL', ['STRATEGY_LIQUIDITY_BELOW_MINIMUM']);
  }
  const filters: string[] = [];
  if (
    !ratioPositive(features.momentum1m) ||
    !ratioPositive(features.momentum5m)
  )
    filters.push('PRICE_MOMENTUM_NOT_POSITIVE');
  if (!ratioAtLeast(features.volumeAcceleration, policy.minVolumeAcceleration))
    filters.push('VOLUME_ACCELERATION_LOW');
  if (!ratioAtLeast(features.buySellRatio, policy.minBuySellRatio))
    filters.push('BUY_PRESSURE_WEAK');
  if ((features.uniqueBuyers5m as number) < policy.minUniqueBuyers5m)
    filters.push('UNIQUE_BUYERS_LOW');
  if (!ratioAtMost(features.volatility5m, policy.maxVolatilityPercentage))
    filters.push('VOLATILITY_TOO_HIGH');
  const pattern = detectBreakout(
    state.breakout,
    candles,
    current as MarketCandle,
    policy,
    filters.length === 0,
  );
  state.breakout = pattern.state;
  if (!pattern.breakout)
    return result(
      'NO_SIGNAL',
      [pattern.reason, ...filters],
      pattern.transitions,
    );
  if (
    state.lastSignalAt &&
    now - Date.parse(state.lastSignalAt) < policy.cooldownSeconds * 1000
  ) {
    state.breakout = { ...emptyBreakout(), stage: 'OBSERVING_MOMENTUM' };
    return result('NO_SIGNAL', ['SIGNAL_COOLDOWN'], pattern.transitions);
  }
  const opportunityKey = stableHash([
    input.mint,
    input.poolAddress,
    hash,
    pattern.state.spikeCandleId,
    pattern.state.pullbackCandleId,
    pattern.state.resistance,
  ]);
  state.lastSignalAt = input.asOf;
  const candidate = {
    id: stableId(['buy-candidate', input.runId, opportunityKey]),
    dataMode: 'FIXTURE' as const,
    mint: input.mint,
    poolAddress: input.poolAddress,
    strategyId: policy.strategyId,
    strategyVersion: policy.version,
    configHash: hash,
    timestamp: input.asOf,
    candleEnd: input.candleEnd,
    referencePriceUsd: (current as MarketCandle).close as string,
    liquidityUsd: liquidity,
    features,
    breakoutReference: pattern.state.resistance as string,
    riskAssessmentId: assessment.id,
    opportunityKey,
    explanation:
      'Completed-candle breakout after a prior spike and separate pullback; required activity and risk checks passed. Fixture research signal only.',
    reasons: ['MOMENTUM_BREAKOUT_CONFIRMED'],
    sourceRefs: input.sourceRefs,
  };
  return result(
    'BUY_CANDIDATE',
    candidate.reasons,
    pattern.transitions,
    candidate,
  );
}
