import {
  backtestOptionsSchema,
  backtestPlanSchema,
  paperPolicySchema,
  stableHash,
  stableId,
} from '@solemn/shared';
import type {
  BacktestOptions,
  BacktestPlan,
  StoredDataset,
} from '@solemn/shared';
import type { Config } from '../config/index.js';
import { strategyPolicy } from '../strategy/signalEngine.js';
import { riskPolicy } from '../risk/tokenRiskEngine.js';
import { paperPolicy } from '../portfolio/policy.js';
export function createBacktestPlan(
  input: unknown,
  dataset: StoredDataset,
  config: Config,
): BacktestPlan {
  const options = backtestOptionsSchema.parse(input),
    startTime = options.startTime ?? dataset.manifest.startTime,
    endTime = options.endTime ?? dataset.manifest.endTime;
  if (
    Date.parse(startTime) < Date.parse(dataset.manifest.startTime) ||
    Date.parse(endTime) > Date.parse(dataset.manifest.endTime) ||
    Date.parse(endTime) <= Date.parse(startTime)
  )
    throw new Error(
      'Requested historical range does not exist in the selected dataset',
    );
  if (Date.parse(startTime) % 60000 !== 0 || Date.parse(endTime) % 60000 !== 0)
    throw new Error('Backtest range must align to UTC minutes');
  const policy = options.paper ?? paperPolicy(config),
    paper = paperPolicySchema.parse({
      ...policy,
      initialBalanceUsd: options.initialBalanceUsd ?? policy.initialBalanceUsd,
    });
  const economic = {
    version: 'solemn-backtest-v1' as const,
    ...(options.execution ? { execution: options.execution } : {}),
    datasetId: dataset.id,
    datasetFingerprint: dataset.fingerprint,
    sourceKind: dataset.manifest.sourceKind,
    startTime,
    endTime,
    tradingMode: 'PAPER' as const,
    executionLatencyMs: options.executionLatencyMs,
    executionWaitMs: options.executionWaitMs,
    equityCadenceMs: options.equityCadenceMs,
    batchSize: options.batchSize,
    maxEvents: options.maxEvents,
    strategy: options.strategy ?? strategyPolicy(config),
    paper,
    risk: options.risk ?? riskPolicy(config),
  };
  const runId =
    options.runId ?? stableId(['backtest-v1', stableHash(economic)]);
  return backtestPlanSchema.parse({
    ...economic,
    runId,
    portfolioId: stableId(['backtest-portfolio-v1', runId]),
    strategyRunId: stableId(['backtest-strategy-v1', runId]),
  });
}
export function strategyConfigForBacktest(
  base: Config,
  plan: BacktestPlan,
): Config {
  const p = plan.strategy,
    r = plan.risk;
  return {
    ...base,
    STRATEGY_ID: p.strategyId,
    STRATEGY_VERSION: p.version,
    STRATEGY_MIN_POOL_AGE_MINUTES: p.minPoolAgeMinutes,
    STRATEGY_MAX_POOL_AGE_MINUTES: p.maxPoolAgeMinutes,
    STRATEGY_MIN_LIQUIDITY_USD: p.minLiquidityUsd,
    STRATEGY_MIN_VOLUME_ACCELERATION: p.minVolumeAcceleration,
    STRATEGY_MIN_BUY_SELL_RATIO: p.minBuySellRatio,
    STRATEGY_MIN_UNIQUE_BUYERS_5M: p.minUniqueBuyers5m,
    STRATEGY_BREAKOUT_LOOKBACK_CANDLES: p.breakoutLookbackCandles,
    STRATEGY_BREAKOUT_BUFFER_PERCENT: p.breakoutBufferPercentage,
    STRATEGY_MIN_PULLBACK_PERCENT: p.minPullbackPercentage,
    STRATEGY_MIN_INITIAL_SPIKE_PERCENT: p.minInitialSpikePercentage,
    STRATEGY_MAX_VOLATILITY_PERCENT: p.maxVolatilityPercentage,
    STRATEGY_PATTERN_MAX_AGE_SECONDS: p.patternMaxAgeSeconds,
    STRATEGY_SIGNAL_COOLDOWN_SECONDS: p.cooldownSeconds,
    STRATEGY_MAX_RISK_ASSESSMENT_AGE_SECONDS: p.maxRiskAgeSeconds,
    STRATEGY_MAX_MARKET_DATA_AGE_SECONDS: p.maxMarketAgeSeconds,
    MARKET_DATA_ALLOWED_LATENESS_MS: p.allowedLatenessMs,
    RISK_POLICY_VERSION: r.version,
    RISK_MIN_LIQUIDITY_USD: r.minLiquidityUsd,
    RISK_MAX_TOP_HOLDERS_PERCENTAGE: r.maxTopHoldersPercentage,
    RISK_MAX_LIQUIDITY_DROP_PERCENTAGE: r.maxLiquidityDropPercentage,
    RISK_MAX_DATA_AGE_SECONDS: r.maxDataAgeSeconds,
    RISK_REQUIRE_HOLDER_DATA: r.requireHolderData,
    RISK_REQUIRE_EXPLICIT_SUSPICIOUS_FLAG: r.requireExplicitSuspiciousFlag,
  };
}
export const parseBacktestOptions = (input: unknown): BacktestOptions =>
  backtestOptionsSchema.parse(input);
