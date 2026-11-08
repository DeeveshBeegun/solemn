import {
  addDecimal,
  marketCandleSchema,
  marketTradeSchema,
  stableHash,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type {
  MarketCandle,
  MarketCorrection,
  MarketCoverage,
  NormalizedMarketTrade,
} from '@solemn/shared';

export const minuteStart = (timestamp: string) =>
  Math.floor(Date.parse(timestamp) / 60000) * 60000;
const iso = (time: number) => new Date(time).toISOString();
function covered(
  segments: MarketCoverage[],
  start: number,
  end: number,
  cutoff: number,
): boolean {
  let cursor = start;
  for (const item of segments
    .filter(
      (segment) =>
        segment.kind === 'OBSERVED' &&
        Date.parse(segment.availableAt) <= cutoff,
    )
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    if (Date.parse(item.start) > cursor) break;
    if (Date.parse(item.end) > cursor) cursor = Date.parse(item.end);
    if (cursor >= end) return true;
  }
  return false;
}
const identity = (trade: NormalizedMarketTrade) => {
  const { receivedAt, rawPayload, ...economic } = trade;
  void receivedAt;
  void rawPayload;
  return stableHash(economic);
};

/** Incremental, bounded observations; published minute inputs freeze at end + allowed lateness. */
export class CandleBuilder {
  private readonly trades = new Map<string, NormalizedMarketTrade>();
  private readonly corrections = new Map<string, MarketCorrection>();
  constructor(
    readonly mint: string,
    readonly pool: string,
    readonly quoteMint: string,
    readonly allowedLatenessMs = 5000,
    private readonly maxTrades = 20000,
  ) {}
  ingest(
    input: NormalizedMarketTrade,
  ): 'ACCEPTED' | 'DUPLICATE' | 'CORRECTION' {
    const trade = marketTradeSchema.parse(input);
    const previous = this.trades.get(trade.id);
    if (previous && identity(previous) === identity(trade)) return 'DUPLICATE';
    const start = minuteStart(trade.timestamp);
    const reason =
      trade.mint !== this.mint || trade.poolAddress !== this.pool
        ? 'WRONG_MARKET'
        : previous
          ? 'CONFLICTING_TRADE'
          : Date.parse(trade.receivedAt) >
              start + 60000 + this.allowedLatenessMs
            ? 'LATE_TRADE'
            : null;
    if (reason) {
      const correction: MarketCorrection = {
        id: stableId([
          'correction',
          trade.id,
          trade.receivedAt,
          identity(trade),
          reason,
        ]),
        tradeId: trade.id,
        receivedAt: trade.receivedAt,
        candleStart: iso(start),
        reason,
        trade,
      };
      this.corrections.set(correction.id, correction);
      if (this.corrections.size > this.maxTrades)
        throw new Error('Market correction capacity exceeded');
      return 'CORRECTION';
    }
    if (this.trades.size >= this.maxTrades)
      throw new Error('Market trade capacity exceeded');
    this.trades.set(trade.id, trade);
    return 'ACCEPTED';
  }
  visibleCorrections(asOf: string): MarketCorrection[] {
    return [...this.corrections.values()].filter(
      (item) => Date.parse(item.receivedAt) <= Date.parse(asOf),
    );
  }
  prune(before: string): void {
    const time = Date.parse(before);
    for (const [id, trade] of this.trades)
      if (Date.parse(trade.timestamp) < time) this.trades.delete(id);
    for (const [id, correction] of this.corrections)
      if (Date.parse(correction.candleStart) < time)
        this.corrections.delete(id);
  }
  build(
    start: string,
    asOf: string,
    coverage: readonly MarketCoverage[],
  ): MarketCandle {
    const begin = minuteStart(start),
      end = begin + 60000,
      cutoff = end + this.allowedLatenessMs,
      at = Date.parse(asOf);
    const seenCoverage = coverage.filter(
      (item) => Date.parse(item.availableAt) <= Math.min(at, cutoff),
    );
    const gap = seenCoverage.some(
      (item) =>
        item.kind === 'GAP' &&
        Date.parse(item.start) < end &&
        Date.parse(item.end) > begin,
    );
    const complete =
      at >= cutoff && !gap && covered(seenCoverage, begin, end, cutoff);
    const trades = [...this.trades.values()]
      .filter(
        (trade) =>
          Date.parse(trade.timestamp) >= begin &&
          Date.parse(trade.timestamp) < end &&
          Date.parse(trade.receivedAt) <= Math.min(at, cutoff),
      )
      .sort(
        (a, b) =>
          Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
          a.id.localeCompare(b.id),
      );
    const issues: string[] = [];
    if (!complete)
      issues.push(
        gap
          ? 'MARKET_DATA_GAP'
          : at < cutoff
            ? 'CANDLE_NOT_FINALIZED'
            : 'COVERAGE_INCOMPLETE',
      );
    const priced = trades.every(
      (trade) => trade.priceUsd !== null && trade.usdReliable,
    );
    const converted = trades.every(
      (trade) =>
        trade.volumeUsd !== null &&
        trade.usdReliable &&
        trade.usdSource !== null &&
        trade.usdObservedAt !== null &&
        Date.parse(trade.usdObservedAt) <= Date.parse(trade.timestamp) &&
        Date.parse(trade.timestamp) - Date.parse(trade.usdObservedAt) <=
          30000 &&
        trade.quoteMint === this.quoteMint,
    );
    if (!priced || trades.length === 0) issues.push('PRICE_UNAVAILABLE');
    if (!converted) issues.push('USD_CONVERSION_UNAVAILABLE');
    if (trades.some((trade) => trade.side === 'UNKNOWN'))
      issues.push('TRADE_DIRECTION_UNKNOWN');
    if (
      trades.some(
        (trade, index) =>
          index > 0 &&
          trade.timestamp === trades[index - 1]?.timestamp &&
          trade.priceUsd !== trades[index - 1]?.priceUsd,
      )
    )
      issues.push('AMBIGUOUS_TRADE_ORDER');
    if (
      trades.some(
        (trade) =>
          trade.priceUsd !== null &&
          trade.volumeUsd !== null &&
          toAtomic(trade.tokenAmount) * toAtomic(trade.priceUsd) !==
            toAtomic(trade.volumeUsd) * 10n ** 18n,
      )
    )
      issues.push('INCONSISTENT_USD_NOTIONAL');
    const prices = priced
      ? trades.map((trade) => trade.priceUsd as string)
      : [];
    const maximum = prices.reduce<string | null>(
      (current, price) =>
        current === null || toAtomic(price) > toAtomic(current)
          ? price
          : current,
      null,
    );
    const minimum = prices.reduce<string | null>(
      (current, price) =>
        current === null || toAtomic(price) < toAtomic(current)
          ? price
          : current,
      null,
    );
    const sum = (side?: 'BUY' | 'SELL'): string | null => {
      if (
        !complete ||
        !converted ||
        (side && issues.includes('TRADE_DIRECTION_UNKNOWN'))
      )
        return null;
      try {
        return trades
          .filter((trade) => !side || trade.side === side)
          .reduce(
            (total, trade) => addDecimal(total, trade.volumeUsd as string),
            '0',
          );
      } catch {
        issues.push('VOLUME_PRECISION_OVERFLOW');
        return null;
      }
    };
    const buyers = trades.some(
      (trade) =>
        trade.side === 'UNKNOWN' ||
        (trade.side === 'BUY' && trade.traderAddress === null),
    )
      ? null
      : [
          ...new Set(
            trades
              .filter((trade) => trade.side === 'BUY')
              .map((trade) => trade.traderAddress as string),
          ),
        ].sort();
    const volumeUsd = sum(),
      buyVolumeUsd = sum('BUY'),
      sellVolumeUsd = sum('SELL');
    const data = {
      mint: this.mint,
      poolAddress: this.pool,
      startTime: iso(begin),
      endTime: iso(end),
      finalizedAt: iso(cutoff),
      open: prices[0] ?? null,
      high: maximum,
      low: minimum,
      close: prices.at(-1) ?? null,
      volumeUsd,
      buyVolumeUsd,
      sellVolumeUsd,
      tradeCount: trades.length,
      uniqueBuyers: buyers?.length ?? null,
      buyers,
      complete,
      issues: [...new Set(issues)],
      tradeIds: trades.map((trade) => trade.id),
    };
    return marketCandleSchema.parse({
      id: stableId(['candle-v1', data]),
      ...data,
    });
  }
}
