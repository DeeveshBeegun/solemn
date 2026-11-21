import type { Config } from '../src/config/index.js';
import { stableId } from '@solemn/shared';
import {
  createReplayFixture,
  replayTime,
} from '../src/strategy/replayFixture.js';
import { CandleBuilder } from '../src/analysis/candleBuilder.js';
import type { FreeMarketSnapshot } from '../src/market/freeGeckoClient.js';
export function freeSnapshot(
  config: Config,
  endMinute: number,
): FreeMarketSnapshot {
  const market = createReplayFixture(config).markets[0]!;
  const at = replayTime(endMinute + 2, 5000);
  const builder = new CandleBuilder(
    market.mint,
    market.poolAddress,
    market.quoteMint,
    config.MARKET_DATA_ALLOWED_LATENESS_MS,
  );
  for (const trade of market.trades)
    if (trade.receivedAt <= at) builder.ingest(trade);
  const candles = Array.from({ length: Math.min(endMinute, 16) }, (_, i) =>
    builder.build(
      replayTime(Math.max(0, endMinute - 16) + i),
      at,
      market.coverage,
    ),
  );
  return {
    mint: market.mint,
    pool: market.poolAddress,
    quoteMint: market.quoteMint,
    poolCreatedAt: market.poolCreatedAt!,
    liquidityUsd: '50000',
    receivedAt: at,
    coverageUntil: replayTime(endMinute),
    lastTradeAt: replayTime(endMinute + 2, 4000),
    candles,
    trades: market.trades.filter((t) => t.receivedAt <= at),
  };
}
export function fixtureRisk(config: Config, at: string) {
  return createReplayFixture(config)
    .markets[0]!.risks.filter((r) => r.availableAt <= at)
    .at(-1)!;
}

/** Injected offline public-provider shape; never used by production clients. */
export function executionSnapshot(
  config: Config,
  at: string,
  price = '1',
): FreeMarketSnapshot {
  const snapshot = freeSnapshot(config, 14);
  const timestamp = new Date(Date.parse(at) - 1000).toISOString();
  const sourceEventId = 'offline-public-trade:' + timestamp + ':' + price;
  const trade = {
    ...snapshot.trades[0]!,
    id: stableId(['offline-public-trade', sourceEventId]),
    source: 'GECKOTERMINAL_PUBLIC',
    sourceEventId,
    timestamp,
    receivedAt: at,
    priceUsd: price,
    usdObservedAt: timestamp,
    usdSource: 'GECKOTERMINAL_TRADE_USD',
    usdReliable: true,
    rawPayload: { isAnomalous: false },
  };
  return {
    ...snapshot,
    receivedAt: at,
    lastTradeAt: timestamp,
    trades: [trade],
  };
}
