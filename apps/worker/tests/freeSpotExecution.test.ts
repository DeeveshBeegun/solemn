import { expect, it } from 'vitest';
import { executionObservationSchema } from '@solemn/shared';
import {
  freeSpotObservation,
  isLaterPaperObservation,
} from '../src/execution/freeSpotExecution.js';
import { freePaperProfile } from '../src/portfolio/freePaperDecisions.js';
import { paperConfig } from './paperFixtures.js';
import { paperPolicy } from '../src/portfolio/policy.js';
import { executionSnapshot } from './freeLiveFixtures.js';
import { loadConfig } from '../src/config/index.js';
const at = '2026-01-01T00:17:00.000Z';
const policy = paperPolicy(paperConfig);
it('uses a precise fresh public trade and labels its paper observation without inventing reserves', () => {
  const snapshot = executionSnapshot(paperConfig, at, '0.000000123456789123');
  const buy = freeSpotObservation(snapshot, 'BUY', at, policy)!;
  expect(buy).toMatchObject({
    dataMode: 'LIVE_PAPER',
    priceUsd: '0.000000123456789123',
    estimatedPriceImpactPercent: null,
    sourceTradeId: snapshot.trades[0]!.id,
  });
  expect(buy.pool).toBeUndefined();
  expect(freeSpotObservation(snapshot, 'SELL', at, policy)!.id).not.toBe(
    buy.id,
  );
  expect(
    executionObservationSchema.safeParse({ ...buy, pool: {} }).success,
  ).toBe(false);
});
it('rejects stale, conflicting, anomalous, fixture, future and missing-liquidity observations', () => {
  const baseline = executionSnapshot(paperConfig, at);
  for (const mutate of [
    (s: typeof baseline) => {
      s.trades[0]!.timestamp = '2026-01-01T00:00:00.000Z';
    },
    (s: typeof baseline) => {
      s.trades.push({ ...s.trades[0]!, priceUsd: '2' });
    },
    (s: typeof baseline) => {
      s.trades[0]!.rawPayload.isAnomalous = true;
    },
    (s: typeof baseline) => {
      s.trades[0]!.source = 'FIXTURE';
    },
    (s: typeof baseline) => {
      s.trades[0]!.timestamp = '2026-01-01T00:18:00.000Z';
    },
    (s: typeof baseline) => {
      s.liquidityUsd = '0';
    },
  ]) {
    const s = structuredClone(baseline);
    mutate(s);
    expect(freeSpotObservation(s, 'BUY', at, policy)).toBeNull();
  }
});
it('requires a strictly later trade after each entry or exit trigger', () => {
  const observation = freeSpotObservation(
    executionSnapshot(paperConfig, at),
    'BUY',
    at,
    policy,
  )!;
  expect(isLaterPaperObservation(observation, observation.observedAt)).toBe(
    false,
  );
  expect(isLaterPaperObservation(observation, at)).toBe(false);
  expect(isLaterPaperObservation(observation, '2026-01-01T00:16:58.000Z')).toBe(
    true,
  );
});
it('requires the live decision engine and isolates the immutable execution profile', () => {
  expect(() =>
    loadConfig({
      DATABASE_URL: paperConfig.DATABASE_URL,
      LIVE_PAPER_EXECUTION_ENABLED: 'true',
    }),
  ).toThrow();
  const config = loadConfig({
    DATABASE_URL: paperConfig.DATABASE_URL,
    STRATEGY_ENABLED: 'true',
    PAPER_TRADING_ENABLED: 'true',
    LIVE_PAPER_DECISIONS_ENABLED: 'true',
  });
  const before = freePaperProfile(config, at),
    after = freePaperProfile(
      { ...config, LIVE_PAPER_EXECUTION_ENABLED: true },
      at,
    );
  expect(after.definition.freeExecution?.model).toBe('FREE_PUBLIC_SPOT_V1');
  expect(after.definition.id).not.toBe(before.definition.id);
  expect(after.run.id).not.toBe(before.run.id);
});
