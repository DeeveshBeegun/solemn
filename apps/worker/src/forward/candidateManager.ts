import { stableHash } from '@solemn/shared';
import type {
  ExecutionObservation,
  HistoricalMarket,
  MarketCandle,
  MarketCoverage,
  PaperPosition,
  StrategyRiskContext,
} from '@solemn/shared';
import { CandleBuilder } from '../analysis/candleBuilder.js';
import type { Config } from '../config/index.js';
import { policyHash, riskPolicy } from '../risk/tokenRiskEngine.js';
import type { ForwardFrame } from './replayProvider.js';

export const marketKey = (mint: string, pool: string) => `${mint}:${pool}`;
export interface MonitoredMarket {
  market: HistoricalMarket;
  builder: CandleBuilder;
  coverage: MarketCoverage[];
  candles: MarketCandle[];
  risk: StrategyRiskContext | null;
  lastTradeAt: string | null;
  quote: ExecutionObservation | null;
  monitoredSince: string;
}
function currentRisk(
  next: StrategyRiskContext,
  previous: StrategyRiskContext | null,
) {
  if (!previous) return true;
  const order = (r: StrategyRiskContext) =>
    [
      r.assessment?.requestedAt ?? r.availableAt,
      String(r.assessment?.attempt ?? 0).padStart(8, '0'),
      r.availableAt,
    ].join(':');
  return order(next) >= order(previous);
}

export class CandidateManager {
  readonly monitored = new Map<string, MonitoredMarket>();
  private readonly discovered = new Set<string>();
  private readonly risks = new Map<string, StrategyRiskContext>();
  private readonly riskHash: string;
  constructor(
    private readonly markets: readonly HistoricalMarket[],
    private readonly config: Config,
  ) {
    this.riskHash = policyHash(riskPolicy(config));
  }
  private rejection(market: HistoricalMarket, at: string) {
    const key = marketKey(market.mint, market.poolAddress),
      risk = this.risks.get(key),
      assessment = risk?.assessment;
    if (!this.discovered.has(key)) return 'AWAITING_DISCOVERY';
    if (
      !market.poolCreatedAt ||
      !market.poolCreationAvailableAt ||
      market.poolCreationAvailableAt > at ||
      market.poolCreatedAt > at
    )
      return 'POOL_CREATION_UNVERIFIED';
    if (
      Date.parse(at) - Date.parse(market.poolCreatedAt) >
      this.config.STRATEGY_MAX_POOL_AGE_MINUTES * 60000
    )
      return 'CANDIDATE_EXPIRED';
    if (
      !assessment ||
      risk.currentStatus !== 'ELIGIBLE' ||
      assessment.status !== 'ELIGIBLE' ||
      risk.currentRequestId !== assessment.requestId ||
      assessment.policyHash !== this.riskHash ||
      !assessment.validUntil ||
      assessment.validUntil <= at ||
      Date.parse(at) - Date.parse(assessment.assessedAt) >=
        this.config.STRATEGY_MAX_RISK_ASSESSMENT_AGE_SECONDS * 1000
    )
      return 'RISK_NOT_CURRENTLY_ELIGIBLE';
    return null;
  }
  ingest(
    frame: ForwardFrame,
    positions: readonly Pick<
      PaperPosition,
      'mint' | 'poolAddress' | 'status'
    >[],
  ) {
    const changes: {
      key: string;
      action: 'WATCH_ADDED' | 'WATCH_REMOVED';
      reason: string;
    }[] = [];
    const held = new Set(
      positions
        .filter((p) => p.status !== 'CLOSED')
        .map((p) => marketKey(p.mint, p.poolAddress)),
    );
    for (const event of frame.events) {
      const key = marketKey(event.mint, event.poolAddress);
      if (event.kind === 'DISCOVERY') this.discovered.add(key);
      if (
        event.kind === 'RISK' &&
        currentRisk(event.data, this.risks.get(key) ?? null)
      )
        this.risks.set(key, event.data);
    }
    const eligible = this.markets.filter((m) => !this.rejection(m, frame.at));
    const selected = new Set(held);
    for (const market of eligible) {
      if (selected.size >= this.config.FORWARD_MAX_TRACKED_TOKENS) break;
      selected.add(marketKey(market.mint, market.poolAddress));
    }
    for (const [key] of this.monitored)
      if (!selected.has(key)) {
        this.monitored.delete(key);
        const market = this.markets.find(
          (m) => marketKey(m.mint, m.poolAddress) === key,
        )!;
        changes.push({
          key,
          action: 'WATCH_REMOVED',
          reason: this.rejection(market, frame.at) ?? 'WATCHLIST_CAPACITY',
        });
      }
    for (const market of this.markets) {
      const key = marketKey(market.mint, market.poolAddress);
      if (!selected.has(key)) continue;
      if (!this.monitored.has(key)) {
        this.monitored.set(key, {
          market,
          builder: new CandleBuilder(
            market.mint,
            market.poolAddress,
            market.quoteMint,
            this.config.MARKET_DATA_ALLOWED_LATENESS_MS,
          ),
          coverage: [],
          candles: [],
          risk: null,
          lastTradeAt: null,
          quote: null,
          monitoredSince: frame.at,
        });
        changes.push({
          key,
          action: 'WATCH_ADDED',
          reason: held.has(key)
            ? 'OPEN_POSITION_PRIORITY'
            : 'CURRENTLY_ELIGIBLE',
        });
      }
      const context = this.monitored.get(key)!;
      context.risk = this.risks.get(key) ?? null;
      if (frame.gap) context.monitoredSince = frame.at;
      if (frame.gap && !frame.connected) {
        context.builder = new CandleBuilder(
          market.mint,
          market.poolAddress,
          market.quoteMint,
          this.config.MARKET_DATA_ALLOWED_LATENESS_MS,
        );
        context.candles = [];
        context.coverage = [];
        context.lastTradeAt = null;
        context.quote = null;
      }
    }
    const quotes = new Map<string, ExecutionObservation>(),
      conflicting = new Set<string>(),
      poolStates = new Map<string, string>();
    for (const event of frame.events) {
      const key = marketKey(event.mint, event.poolAddress),
        context = this.monitored.get(key);
      if (!context || !frame.connected) continue;
      if (
        event.kind === 'TRADE' &&
        context.builder.ingest(event.data) === 'ACCEPTED' &&
        event.data.usdReliable &&
        event.data.priceUsd &&
        event.data.volumeUsd !== null &&
        event.data.usdSource &&
        event.data.usdObservedAt &&
        event.data.quoteMint === context.market.quoteMint &&
        Date.parse(event.data.timestamp) -
          Date.parse(event.data.usdObservedAt) <=
          30000 &&
        event.data.usdObservedAt <= event.data.timestamp &&
        event.data.side !== 'UNKNOWN'
      ) {
        if (!context.lastTradeAt || context.lastTradeAt < event.data.timestamp)
          context.lastTradeAt = event.data.timestamp;
      }
      if (
        event.kind === 'COVERAGE' &&
        (event.data.kind === 'GAP' ||
          Date.parse(event.data.start) >= Date.parse(context.monitoredSince))
      ) {
        if (context.coverage.length >= 1000)
          throw new Error('Forward coverage capacity exceeded');
        context.coverage.push(event.data);
      }
      if (event.kind === 'EXECUTION') {
        const sideKey = `${key}:${event.data.side}`,
          previous = quotes.get(sideKey);
        if (previous && stableHash(previous) !== stableHash(event.data))
          conflicting.add(key);
        const pool = event.data.pool;
        if (pool) {
          const poolKey = `${key}:${pool.observedAt}`,
            fingerprint = stableHash({ ...pool, id: null });
          const earlier = poolStates.get(poolKey);
          if (earlier && earlier !== fingerprint) conflicting.add(key);
          poolStates.set(poolKey, fingerprint);
        }
        quotes.set(sideKey, event.data);
      }
    }
    for (const [sideKey, quote] of quotes) {
      const key = marketKey(quote.mint, quote.poolAddress),
        context = this.monitored.get(key)!;
      if (conflicting.has(key)) {
        context.quote = null;
        quotes.delete(sideKey);
        continue;
      }
      if (
        quote.healthy &&
        quote.pool &&
        quote.pool.availableAt <= frame.at &&
        (!context.quote || context.quote.observedAt < quote.observedAt)
      )
        context.quote = quote;
    }
    return {
      changes,
      quotes: [...quotes.values()],
      conflicts: conflicting.size,
    };
  }
  finalize(context: MonitoredMarket, end: string, at: string) {
    const candle = context.builder.build(
      new Date(Date.parse(end) - 60000).toISOString(),
      at,
      context.coverage,
    );
    context.candles.push(candle);
    if (context.candles.length > 16) context.candles.shift();
    const cutoff = new Date(Date.parse(end) - 17 * 60000).toISOString();
    context.builder.prune(cutoff);
    context.coverage = context.coverage.filter((c) => c.end >= cutoff);
    return candle;
  }
  entryReady(context: MonitoredMarket, at: string) {
    const candles = context.candles.slice(-10);
    const cutoff = Date.parse(at) - 16 * 60000;
    return (
      !this.rejection(context.market, at) &&
      this.fresh(context, at) &&
      candles.length === 10 &&
      candles.every((c) => c.complete && !c.issues.length) &&
      !context.builder
        .visibleCorrections(at)
        .some((c) => Date.parse(c.candleStart) >= cutoff)
    );
  }
  fresh(context: MonitoredMarket, at: string) {
    return (
      context.lastTradeAt !== null &&
      Date.parse(at) - Date.parse(context.lastTradeAt) <=
        this.config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS * 1000
    );
  }
}
