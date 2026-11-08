import { describe, expect, it } from 'vitest';
import type { StrategyRiskContext } from '@solemn/shared';
import {
  createReplayFixture,
  replayTime,
} from '../src/strategy/replayFixture.js';
import { replayStrategy } from '../src/strategy/replay.js';
import { evaluateSignal } from '../src/strategy/signalEngine.js';
import type { SignalEvaluation } from '../src/strategy/signalEngine.js';
import {
  strategyConfig,
  memoryStrategyRepository,
} from './strategyFixtures.js';

async function entry() {
  const fixture = createReplayFixture(strategyConfig),
    store = memoryStrategyRepository();
  const result = await replayStrategy(
    fixture,
    strategyConfig,
    store.repository,
  );
  const decision = result.decisions.find((item) => item.candidate)!;
  const market = fixture.markets[0]!;
  const input: SignalEvaluation = {
    runId: result.run.id,
    mint: market.mint,
    poolAddress: market.poolAddress,
    poolCreatedAt: market.poolCreatedAt,
    asOf: decision.timestamp,
    candleEnd: replayTime(14),
    candles: [...store.candles.values()].filter(
      (candle) => candle.mint === market.mint,
    ),
    risk: decision.risk,
    feedHealthy: true,
    lastMarketUpdateAt: replayTime(14, 1000),
    corrections: [],
    sourceRefs: decision.sourceRefs,
  };
  return { input, state: decision.stateBefore };
}
describe('strategy mandatory gates', () => {
  it.each([
    'missing',
    'rejected',
    'unknown',
    'newer-request',
    'stale',
    'policy',
    'stale-liquidity',
  ] as const)('blocks %s risk evidence', async (mode) => {
    const { input, state } = await entry();
    const risk = input.risk as StrategyRiskContext;
    if (mode === 'missing') input.risk = null;
    if (mode === 'rejected') risk.currentStatus = 'REJECTED';
    if (mode === 'unknown') risk.currentStatus = 'UNKNOWN';
    if (mode === 'newer-request') risk.currentRequestId = null;
    if (mode === 'stale') input.asOf = replayTime(17);
    if (mode === 'policy') risk.assessment!.policyHash = 'f'.repeat(64);
    if (mode === 'stale-liquidity')
      risk.assessment!.evidence.jupiter.updatedAt = replayTime(0);
    expect(evaluateSignal(input, state, strategyConfig).outcome).toBe(
      'BLOCKED_BY_RISK',
    );
  });
  it.each([
    'disconnected',
    'stale-feed',
    'missing-history',
    'unknown-pool-age',
    'invalid-pool-age',
    'low-liquidity',
    'no-volume',
    'few-buyers',
    'cooldown',
  ] as const)('prevents candidates for %s', async (mode) => {
    const { input, state } = await entry();
    if (mode === 'disconnected') input.feedHealthy = false;
    if (mode === 'stale-feed') input.lastMarketUpdateAt = replayTime(12);
    if (mode === 'missing-history') input.candles = input.candles.slice(-2);
    if (mode === 'unknown-pool-age') input.poolCreatedAt = null;
    if (mode === 'invalid-pool-age') input.poolCreatedAt = replayTime(13);
    if (mode === 'low-liquidity')
      input.risk!.assessment!.checks.liquidityUsd = '39999';
    if (mode === 'no-volume')
      input.candles
        .filter((candle) => candle.endTime <= replayTime(14))
        .slice(-5)
        .forEach((candle) => {
          candle.volumeUsd = '1';
        });
    if (mode === 'few-buyers')
      input.candles.forEach((candle) => {
        candle.buyers = [];
        candle.uniqueBuyers = 0;
      });
    if (mode === 'cooldown') state.lastSignalAt = replayTime(13);
    const decision = evaluateSignal(input, state, strategyConfig);
    expect(decision.candidate).toBeNull();
    if (mode === 'cooldown')
      expect(decision.reasons).toContain('SIGNAL_COOLDOWN');
  });
});
