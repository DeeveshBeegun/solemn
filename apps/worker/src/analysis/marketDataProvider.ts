import { marketDatasetSchema } from '@solemn/shared';
import type {
  FixtureMarket,
  MarketDataset,
  NormalizedMarketTrade,
  StrategyRiskContext,
} from '@solemn/shared';

export interface MarketDataProvider {
  getRecentTrades(
    mint: string,
    pool: string,
    since: string,
    asOf: string,
  ): Promise<NormalizedMarketTrade[]>;
  getLatestPrice(
    mint: string,
    pool: string,
    asOf: string,
  ): Promise<{ priceUsd: string; observedAt: string; tradeId: string } | null>;
}

/** Explicit fixture/replay observations only. No external data connection or price invention. */
export class FixtureReplayProvider implements MarketDataProvider {
  readonly dataset: MarketDataset;
  constructor(input: unknown, maxMarkets = 10) {
    this.dataset = marketDatasetSchema.parse(input);
    if (this.dataset.markets.length > maxMarkets)
      throw new Error('Replay exceeds maximum tracked tokens');
    for (const market of this.dataset.markets) {
      if (market.trades.some((trade) => trade.mint !== market.mint))
        throw new Error('Trade mint does not match its fixture market');
      if (
        market.risks.some(
          (risk) =>
            risk.assessment !== null &&
            risk.assessment.tokenMint !== market.mint,
        )
      )
        throw new Error('Risk mint does not match fixture market');
    }
  }
  market(mint: string, pool: string): FixtureMarket {
    const market = this.dataset.markets.find(
      (item) => item.mint === mint && item.poolAddress === pool,
    );
    if (!market) throw new Error('Unsupported fixture market');
    return market;
  }
  async getRecentTrades(
    mint: string,
    pool: string,
    since: string,
    asOf: string,
  ) {
    return structuredClone(
      this.market(mint, pool)
        .trades.filter(
          (trade) =>
            Date.parse(trade.receivedAt) <= Date.parse(asOf) &&
            Date.parse(trade.timestamp) >= Date.parse(since),
        )
        .sort(
          (a, b) =>
            Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
            a.id.localeCompare(b.id),
        ),
    );
  }
  async getLatestPrice(mint: string, pool: string, asOf: string) {
    const trades = await this.getRecentTrades(
      mint,
      pool,
      this.dataset.start,
      asOf,
    );
    const trade = trades
      .filter(
        (item) =>
          item.poolAddress === pool &&
          item.priceUsd !== null &&
          item.usdReliable &&
          item.usdSource !== null &&
          item.usdObservedAt !== null &&
          item.quoteMint === this.market(mint, pool).quoteMint &&
          Date.parse(item.usdObservedAt) <= Date.parse(item.timestamp) &&
          Date.parse(item.timestamp) - Date.parse(item.usdObservedAt) <= 30000,
      )
      .sort(
        (a, b) =>
          Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
          a.id.localeCompare(b.id),
      )[0];
    return trade?.priceUsd
      ? {
          priceUsd: trade.priceUsd,
          observedAt: trade.timestamp,
          tradeId: trade.id,
        }
      : null;
  }
  riskAt(market: FixtureMarket, asOf: string): StrategyRiskContext | null {
    return structuredClone(
      market.risks
        .filter((item) => Date.parse(item.availableAt) <= Date.parse(asOf))
        .sort((a, b) => {
          const request = (item: StrategyRiskContext) =>
            Date.parse(item.assessment?.requestedAt ?? item.availableAt);
          return (
            request(b) - request(a) ||
            (b.assessment?.attempt ?? 0) - (a.assessment?.attempt ?? 0) ||
            Date.parse(b.availableAt) - Date.parse(a.availableAt)
          );
        })[0] ?? null,
    );
  }
}
