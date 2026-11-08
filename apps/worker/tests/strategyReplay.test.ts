import { describe, expect, it } from 'vitest';
import { stableId } from '@solemn/shared';
import {
  createReplayFixture,
  replayTime,
} from '../src/strategy/replayFixture.js';
import { replayStrategy } from '../src/strategy/replay.js';
import {
  strategyConfig,
  memoryStrategyRepository,
} from './strategyFixtures.js';

describe('deterministic five-case strategy replay', () => {
  it('blocks future entries when a gap is reported after candle publication', async () => {
    const fixture = createReplayFixture(strategyConfig);
    fixture.markets = fixture.markets.slice(0, 1);
    const market = fixture.markets[0]!;
    market.coverage.push({
      id: stableId(['late-gap']),
      start: replayTime(7),
      end: replayTime(8),
      availableAt: replayTime(13),
      kind: 'GAP',
      reason: 'LATE_GAP_REPORT',
    });
    const result = await replayStrategy(
      fixture,
      strategyConfig,
      memoryStrategyRepository().repository,
    );
    expect(result.metrics.buyCandidates).toBe(0);
    expect(
      result.decisions.find(
        (decision) => decision.timestamp === replayTime(14, 5000),
      )?.reasons,
    ).toContain('FEED_DISCONNECTED');
  });
  it('produces one evidenced breakout and preserves rejected, weak, failed and incomplete decisions', async () => {
    const store = memoryStrategyRepository(),
      fixture = createReplayFixture(strategyConfig);
    const result = await replayStrategy(
      fixture,
      strategyConfig,
      store.repository,
    );
    expect(result.decisions).toHaveLength(90);
    const buys = result.decisions.filter((decision) => decision.candidate);
    expect(buys).toHaveLength(1);
    const buy = buys[0]!;
    expect(buy.mint).toBe(fixture.markets[0]!.mint);
    expect(buy.timestamp).toBe(replayTime(14, 5000));
    expect(buy.candidate).toMatchObject({
      referencePriceUsd: '124',
      breakoutReference: '120',
      dataMode: 'FIXTURE',
    });
    expect(buy.candidate?.features.uniqueBuyers5m).toBe(50);
    expect(buy.candidate?.features.volumeAcceleration.value).toBe(
      '7.358333333333333333',
    );
    expect(buy.candidate?.features.buySellRatio.value).toBe(
      '4.934139784946236559',
    );
    expect(buy.transitions).toContain('PULLBACK_CONFIRMED->BREAKOUT_CONFIRMED');
    expect(
      result.decisions
        .filter((decision) => decision.mint === fixture.markets[2]!.mint)
        .every((decision) => decision.outcome === 'BLOCKED_BY_RISK'),
    ).toBe(true);
    expect(
      result.decisions.some(
        (decision) =>
          decision.mint === fixture.markets[4]!.mint &&
          decision.reasons.includes('CANDLE_DATA_INCOMPLETE'),
      ),
    ).toBe(true);
    expect(store.candles.size).toBe(90);
    const again = await replayStrategy(
      fixture,
      strategyConfig,
      store.repository,
    );
    expect(again.decisions).toEqual(result.decisions);
    expect(again.metrics.duplicateDecisions).toBe(90);
    expect(store.decisions.size).toBe(90);
  });
  it('does not use future trades, future coverage, future risk or delayed receipts', async () => {
    const fixture = createReplayFixture(strategyConfig);
    const original = await replayStrategy(
      fixture,
      strategyConfig,
      memoryStrategyRepository().repository,
    );
    for (const market of fixture.markets) {
      market.trades = market.trades.filter(
        (trade) => trade.timestamp < replayTime(15),
      );
      market.risks = market.risks.filter(
        (risk) => risk.availableAt < replayTime(15),
      );
      market.coverage = market.coverage.filter(
        (coverage) => coverage.availableAt < replayTime(15),
      );
    }
    const altered = await replayStrategy(
      fixture,
      strategyConfig,
      memoryStrategyRepository().repository,
    );
    // Run IDs intentionally change with dataset content; compare all evaluation evidence.
    const normalize = (decision: (typeof original.decisions)[number]) => ({
      ...decision,
      id: '',
      runId: '',
      candidate: decision.candidate ? { ...decision.candidate, id: '' } : null,
    });
    expect(
      altered.decisions
        .filter((decision) => decision.timestamp <= replayTime(14, 5000))
        .map(normalize),
    ).toEqual(
      original.decisions
        .filter((decision) => decision.timestamp <= replayTime(14, 5000))
        .map(normalize),
    );
    const delayed = createReplayFixture(strategyConfig);
    delayed.markets = delayed.markets.slice(0, 1);
    for (const trade of delayed.markets[0]!.trades.filter(
      (trade) =>
        trade.timestamp >= replayTime(13) && trade.timestamp < replayTime(14),
    ))
      trade.receivedAt = replayTime(15);
    const store = memoryStrategyRepository();
    const result = await replayStrategy(
      delayed,
      strategyConfig,
      store.repository,
    );
    expect(result.metrics.buyCandidates).toBe(0);
    expect(store.corrections.size).toBe(12);
  });
  it('keeps duplicate and out-of-order source trades from multiplying volume', async () => {
    const fixture = createReplayFixture(strategyConfig);
    fixture.markets = fixture.markets.slice(0, 1);
    const original = await replayStrategy(
      fixture,
      strategyConfig,
      memoryStrategyRepository().repository,
    );
    const market = fixture.markets[0]!;
    market.trades = [
      ...market.trades.reverse(),
      structuredClone(market.trades[0]!),
    ];
    const again = await replayStrategy(
      fixture,
      strategyConfig,
      memoryStrategyRepository().repository,
    );
    expect(again.metrics.buyCandidates).toBe(1);
    expect(
      again.decisions.find((decision) => decision.candidate)?.features,
    ).toEqual(
      original.decisions.find((decision) => decision.candidate)?.features,
    );
    expect(stableId(['deterministic'])).toBe(stableId(['deterministic']));
  });
});
