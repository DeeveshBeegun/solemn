import { describe, expect, it } from 'vitest';
import { marketTradeSchema, stableId, toAtomic } from '@solemn/shared';
import { CandleBuilder } from '../src/analysis/candleBuilder.js';
import { FixtureReplayProvider } from '../src/analysis/marketDataProvider.js';
import { analyzeMomentum } from '../src/analysis/momentumAnalyzer.js';
import {
  createReplayFixture,
  replayTime,
} from '../src/strategy/replayFixture.js';
import { exactRatio, ratioAtLeast } from '../src/strategy/exactMath.js';
import { strategyConfig } from './strategyFixtures.js';

function setup(minute = 11) {
  const market = createReplayFixture(strategyConfig).markets[0]!;
  const builder = new CandleBuilder(
    market.mint,
    market.poolAddress,
    market.quoteMint,
  );
  const trades = market.trades.filter(
    (trade) =>
      trade.timestamp >= replayTime(minute) &&
      trade.timestamp < replayTime(minute + 1),
  );
  return {
    market,
    builder,
    trades,
    build: () =>
      builder.build(
        replayTime(minute),
        replayTime(minute + 1, 5000),
        market.coverage,
      ),
  };
}
describe('exact candles and data quality', () => {
  it('exposes only received prices with reliable scoped USD conversion', async () => {
    const fixture = createReplayFixture(strategyConfig);
    const market = fixture.markets[0]!;
    const provider = new FixtureReplayProvider(fixture);
    expect(
      await provider.getLatestPrice(
        market.mint,
        market.poolAddress,
        replayTime(10),
      ),
    ).toMatchObject({ priceUsd: '100' });
    market.trades.forEach((trade) => {
      trade.usdSource = null;
    });
    expect(
      await new FixtureReplayProvider(fixture).getLatestPrice(
        market.mint,
        market.poolAddress,
        replayTime(18),
      ),
    ).toBeNull();
    await expect(
      provider.getLatestPrice(market.mint, market.mint, replayTime(18)),
    ).rejects.toThrow('Unsupported fixture market');
    const latest = market.risks[13]!;
    latest.currentStatus = 'UNKNOWN';
    expect(
      new FixtureReplayProvider(fixture).riskAt(market, replayTime(14))
        ?.currentStatus,
    ).toBe('UNKNOWN');
  });
  it('aggregates OHLC, USD sides and buyers independent of arrival order', () => {
    const { trades, builder, build } = setup();
    [...trades].reverse().forEach((trade) => builder.ingest(trade));
    expect(builder.ingest(trades[0]!)).toBe('DUPLICATE');
    const candle = build();
    expect(candle).toMatchObject({
      open: '100',
      high: '120',
      low: '100',
      close: '120',
      tradeCount: 12,
      volumeUsd: '1400',
      buyVolumeUsd: '1160',
      sellVolumeUsd: '240',
      uniqueBuyers: 10,
      complete: true,
      issues: [],
    });
  });
  it('uses half-open minute boundaries and does not finalize early', () => {
    const { trades, builder, market } = setup();
    const trade = {
      ...trades[0]!,
      timestamp: replayTime(12),
      receivedAt: replayTime(12, 100),
    };
    builder.ingest(trade);
    expect(
      builder.build(replayTime(11), replayTime(12, 5000), market.coverage)
        .tradeCount,
    ).toBe(0);
    expect(
      builder.build(replayTime(12), replayTime(13, 4999), market.coverage)
        .complete,
    ).toBe(false);
    expect(
      builder.build(replayTime(12), replayTime(13, 5000), market.coverage)
        .tradeCount,
    ).toBe(1);
  });
  it('distinguishes observed zero trading from missing coverage', () => {
    const { builder, market, build } = setup();
    expect(build()).toMatchObject({
      complete: true,
      volumeUsd: '0',
      close: null,
    });
    expect(
      builder.build(replayTime(11), replayTime(12, 5000), []),
    ).toMatchObject({ complete: false, volumeUsd: null });
    market.coverage[11]!.kind = 'GAP';
    expect(build().issues).toContain('MARKET_DATA_GAP');
  });
  it.each(['price', 'conversion', 'direction', 'buyer', 'quote'] as const)(
    'preserves missing or incompatible %s information',
    (field) => {
      const { builder, trades, build, market } = setup();
      const trade = structuredClone(trades[0]!);
      if (field === 'price') trade.priceUsd = null;
      if (field === 'conversion') {
        trade.usdReliable = false;
        trade.volumeUsd = null;
      }
      if (field === 'direction') trade.side = 'UNKNOWN';
      if (field === 'buyer') trade.traderAddress = null;
      if (field === 'quote') trade.quoteMint = market.mint;
      builder.ingest(trade);
      const candle = build();
      if (field === 'price') expect(candle.close).toBeNull();
      if (field === 'conversion' || field === 'quote')
        expect(candle.volumeUsd).toBeNull();
      if (field === 'direction') expect(candle.buyVolumeUsd).toBeNull();
      if (field === 'buyer') expect(candle.uniqueBuyers).toBeNull();
    },
  );
  it('records late and conflicting observations without rewriting finalized candles', () => {
    const { builder, trades, build } = setup();
    trades.forEach((trade) => builder.ingest(trade));
    const before = build();
    expect(
      builder.ingest({
        ...trades[0]!,
        receivedAt: replayTime(14),
        priceUsd: '999',
      }),
    ).toBe('CORRECTION');
    const sourceEventId = 'late-event';
    expect(
      builder.ingest({
        ...trades[0]!,
        id: stableId(['market-trade', 'SOLEMN_FIXTURE', sourceEventId]),
        sourceEventId,
        receivedAt: replayTime(14),
      }),
    ).toBe('CORRECTION');
    expect(build()).toEqual(before);
    expect(builder.visibleCorrections(replayTime(13))).toHaveLength(0);
    expect(builder.visibleCorrections(replayTime(14))).toHaveLength(2);
  });
  it('rejects zero prices and aggregates quantities above Number safe integer precisely', () => {
    const { builder, trades, build } = setup();
    expect(
      marketTradeSchema.safeParse({ ...trades[0], priceUsd: '0' }).success,
    ).toBe(false);
    builder.ingest({
      ...trades[0]!,
      tokenAmount: '9007199254740993',
      priceUsd: '1',
      volumeUsd: '9007199254740993',
    });
    expect(build().volumeUsd).toBe('9007199254740993');
  });
});
describe('time-consistent momentum indicators', () => {
  const candles = () => {
    const market = createReplayFixture(strategyConfig).markets[0]!,
      builder = new CandleBuilder(
        market.mint,
        market.poolAddress,
        market.quoteMint,
      );
    market.trades.forEach((trade) => builder.ingest(trade));
    return Array.from({ length: 18 }, (_, minute) =>
      builder.build(replayTime(minute), replayTime(18, 5000), market.coverage),
    );
  };
  it('calculates positive, negative, flat momentum, volume acceleration and buying pressure', () => {
    const input = candles();
    expect(analyzeMomentum(input, replayTime(12)).momentum1m.value).toBe('20');
    expect(analyzeMomentum(input, replayTime(13)).momentum1m.value).toBe('-10');
    expect(analyzeMomentum(input, replayTime(11)).momentum1m.value).toBe('0');
    const breakout = analyzeMomentum(input, replayTime(14));
    expect(ratioAtLeast(breakout.volumeAcceleration, '2')).toBe(true);
    expect(ratioAtLeast(breakout.buySellRatio, '1.5')).toBe(true);
    expect(breakout.uniqueBuyers5m).toBe(50);
    expect(breakout.momentum15m.state).toBe('UNAVAILABLE');
    expect(analyzeMomentum(input, replayTime(18)).momentum15m.state).toBe(
      'AVAILABLE',
    );
  });
  it('classifies zero denominators, missing history, missing identities and selling pressure', () => {
    const input = candles().slice(0, 10);
    input.slice(0, 5).forEach((candle) => {
      candle.volumeUsd = '0';
    });
    expect(
      analyzeMomentum(input, replayTime(10)).volumeAcceleration.state,
    ).toBe('ZERO_DENOMINATOR');
    input.slice(5).forEach((candle) => {
      candle.sellVolumeUsd = '0';
    });
    expect(analyzeMomentum(input, replayTime(10)).buySellRatio.state).toBe(
      'ZERO_DENOMINATOR',
    );
    expect(
      analyzeMomentum(input.slice(1), replayTime(10)).volumeAcceleration.state,
    ).toBe('UNAVAILABLE');
    input[9]!.buyers = null;
    expect(analyzeMomentum(input, replayTime(10)).uniqueBuyers5m).toBeNull();
    input.slice(5).forEach((candle) => {
      candle.sellVolumeUsd = '1000';
      candle.buyVolumeUsd = '1';
    });
    expect(analyzeMomentum(input, replayTime(10)).buySellRatio.value).toBe(
      '0.001',
    );
  });
  it('compares full rational precision rather than the truncated display', () => {
    const ratio = exactRatio(
      toAtomic('9007199254740993.000000000000000001'),
      toAtomic('9007199254740993'),
    );
    expect(ratio.value).toBe('1');
    expect(ratioAtLeast(ratio, '1.000000000000000001')).toBe(false);
    expect(ratioAtLeast(ratio, '1')).toBe(true);
  });
});
