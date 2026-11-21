import { parse } from 'lossless-json';
import { z } from 'zod';
import {
  fromAtomic,
  toAtomic,
  stableId,
  marketCandleSchema,
  marketTradeSchema,
  mintAddressSchema,
  timestampSchema,
} from '@solemn/shared';
import type { MarketCandle, NormalizedMarketTrade } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { geckoTerminalBaseUrlSchema } from '../config/index.js';
import { HttpReader } from '../analysis/httpReader.js';

const minute = (at: number) => Math.floor(at / 60000) * 60000;
const iso = (at: number) => new Date(at).toISOString();
const source = 'GECKOTERMINAL_PUBLIC';
export class FreeMarketError extends Error {}

/** Provider observations are explicitly quantized down to the system's 18 decimals.
 * Raw price/notional strings are retained; amounts never pass through Number. */
export function freeDecimal(input: unknown): string | null {
  if (
    typeof input !== 'string' ||
    !/^\d+(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i.test(input) ||
    input.length > 180
  )
    return null;
  const [mantissa = '', exp = '0'] = input.toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const shift = 18 + Number(exp) - fraction.length;
  if (Math.abs(shift) > 120) return null;
  const coefficient = BigInt(whole + fraction);
  const atomic =
    shift >= 0
      ? coefficient * 10n ** BigInt(shift)
      : coefficient / 10n ** BigInt(-shift);
  const value = fromAtomic(atomic);
  try {
    toAtomic(value);
    return value;
  } catch {
    return null;
  }
}
const amount = (value: unknown, positive = false) => {
  const result = freeDecimal(value);
  if (result === null || (positive && toAtomic(result) === 0n))
    throw new FreeMarketError('FREE_MARKET_DECIMAL_UNAVAILABLE');
  return result;
};
const relationship = z.object({ data: z.object({ id: z.string().max(160) }) });
const poolSchema = z.looseObject({
  attributes: z.looseObject({
    address: mintAddressSchema,
    pool_created_at: timestampSchema,
    reserve_in_usd: z.string().max(180),
  }),
  relationships: z.looseObject({
    base_token: relationship,
    quote_token: relationship,
  }),
});
const tradesSchema = z.object({
  data: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(400),
        attributes: z.looseObject({
          block_timestamp: timestampSchema,
          tx_hash: z.string().max(128),
          tx_from_address: z.string().nullish(),
          kind: z.enum(['buy', 'sell']),
          from_token_address: mintAddressSchema,
          to_token_address: mintAddressSchema,
          from_token_amount: z.string().max(180),
          to_token_amount: z.string().max(180),
          price_from_in_usd: z.string().max(180),
          price_to_in_usd: z.string().max(180),
          volume_in_usd: z.string().max(180),
          is_anomalous: z.boolean(),
        }),
      }),
    )
    .max(300),
});
const barsSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.array(z.string().max(180)).length(6)).max(30),
    }),
  }),
});
export type FreeMarketSnapshot = {
  mint: string;
  pool: string;
  quoteMint: string;
  poolCreatedAt: string;
  liquidityUsd: string;
  receivedAt: string;
  coverageUntil: string;
  lastTradeAt: string | null;
  candles: MarketCandle[];
  trades: NormalizedMarketTrade[];
};
export interface FreeMarketClient {
  read(
    mint: string,
    signal: AbortSignal,
    pool?: string,
  ): Promise<FreeMarketSnapshot>;
}

/** Exactly the documented public GET endpoints. No keys, paid headers, redirects or fallback hosts. */
export class GeckoPublicClient implements FreeMarketClient {
  private readonly reader: HttpReader;
  private readonly base: string;
  constructor(
    private readonly config: Config,
    fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.base = geckoTerminalBaseUrlSchema.parse(config.GECKOTERMINAL_BASE_URL);
    this.reader = new HttpReader(
      { ...config, RISK_HTTP_MAX_ATTEMPTS: 1 },
      config.FREE_MARKET_REQUEST_INTERVAL_MS,
      fetcher,
      undefined,
      now,
    );
  }
  private async get(path: string, signal: AbortSignal) {
    const requestedAt = this.now();
    const result = await this.reader.request(
      this.base + path,
      {
        method: 'GET',
        headers: { Accept: 'application/json;version=20230203' },
      },
      signal,
    );
    let json: unknown;
    try {
      json = parse(result.body, undefined, (number) => number);
    } catch {
      throw new FreeMarketError('FREE_MARKET_RESPONSE_INVALID');
    }
    return { json, requestedAt, receivedAt: result.receivedAt };
  }
  async read(
    input: string,
    signal: AbortSignal,
    pinnedPool?: string,
  ): Promise<FreeMarketSnapshot> {
    const mint = mintAddressSchema.parse(input);
    const response = await this.get(
      '/networks/solana/tokens/' + mint + '/pools',
      signal,
    );
    const pools = z
      .object({ data: z.array(z.unknown()).max(50) })
      .parse(response.json)
      .data.map((p) => poolSchema.safeParse(p))
      .filter((p) => p.success)
      .map((p) => p.data)
      .filter(
        (p) =>
          p.relationships.base_token.data.id === 'solana_' + mint &&
          (!pinnedPool || p.attributes.address === pinnedPool) &&
          Date.parse(p.attributes.pool_created_at) <= this.now(),
      )
      .map((p) => ({
        ...p,
        liquidity: freeDecimal(p.attributes.reserve_in_usd),
      }))
      .filter(
        (p) =>
          p.liquidity !== null &&
          (pinnedPool
            ? toAtomic(p.liquidity) > 0n
            : toAtomic(p.liquidity) >=
              toAtomic(this.config.STRATEGY_MIN_LIQUIDITY_USD)),
      )
      .sort((a, b) =>
        toAtomic(a.liquidity!) > toAtomic(b.liquidity!)
          ? -1
          : toAtomic(a.liquidity!) < toAtomic(b.liquidity!)
            ? 1
            : a.attributes.address.localeCompare(b.attributes.address),
      );
    const pool = pools[0];
    if (!pool)
      throw new FreeMarketError('FREE_MARKET_POOL_NOT_INDEXED_OR_LIQUID');
    const poolAddress = pool.attributes.address;
    const quoteMint = mintAddressSchema.parse(
      pool.relationships.quote_token.data.id.replace(/^solana_/, ''),
    );
    const barResponse = await this.get(
      '/networks/solana/pools/' +
        poolAddress +
        '/ohlcv/minute?aggregate=1&limit=20&currency=usd&include_empty_intervals=false&token=' +
        mint,
      signal,
    );
    const tradeResponse = await this.get(
      '/networks/solana/pools/' +
        poolAddress +
        '/trades?token=' +
        mint +
        '&include_anomalous=true',
      signal,
    );
    // Both APIs can be cached for one minute. Never assert coverage of their recent tail.
    const coverageUntil = minute(
      Math.min(tradeResponse.requestedAt, barResponse.requestedAt) - 65000,
    );
    return normalizeFreeSnapshot(
      mint,
      poolAddress,
      quoteMint,
      pool.attributes.pool_created_at,
      pool.liquidity!,
      tradeResponse.json,
      barResponse.json,
      tradeResponse.receivedAt,
      iso(coverageUntil),
    );
  }
}

/** Provider OHLC supplies price ordering; second-resolution trades alone cannot establish it. */
export function normalizeFreeSnapshot(
  mint: string,
  pool: string,
  quoteMint: string,
  poolCreatedAt: string,
  liquidityUsd: string,
  tradeInput: unknown,
  barInput: unknown,
  receivedAt: string,
  coverageUntil: string,
): FreeMarketSnapshot {
  const raw = tradesSchema.parse(tradeInput).data;
  const seen = new Map<string, string>();
  const trades: NormalizedMarketTrade[] = [];
  const anomalous = new Set<string>();
  for (const row of raw) {
    const a = row.attributes,
      buy = a.kind === 'buy';
    if (
      (buy ? a.to_token_address : a.from_token_address) !== mint ||
      (buy ? a.from_token_address : a.to_token_address) !== quoteMint
    )
      throw new FreeMarketError('FREE_MARKET_TRADE_SCOPE_MISMATCH');
    if (Date.parse(a.block_timestamp) < Date.parse(poolCreatedAt))
      throw new FreeMarketError('FREE_MARKET_TRADE_PREDATES_POOL');
    if (Date.parse(a.block_timestamp) > Date.parse(receivedAt))
      throw new FreeMarketError('FREE_MARKET_FUTURE_TRADE');
    const fingerprint = JSON.stringify(a);
    if (seen.has(row.id)) {
      if (seen.get(row.id) !== fingerprint)
        throw new FreeMarketError('FREE_MARKET_CONFLICTING_TRADE');
      else continue;
    }
    seen.set(row.id, fingerprint);
    const sourceEventId = pool + ':' + row.id;
    const trader = mintAddressSchema.safeParse(a.tx_from_address);
    const rawPrice = buy ? a.price_to_in_usd : a.price_from_in_usd;
    const trade = marketTradeSchema.parse({
      id: stableId(['market-trade', source, sourceEventId]),
      mint,
      poolAddress: pool,
      source,
      sourceEventId,
      timestamp: a.block_timestamp,
      receivedAt,
      side: buy ? 'BUY' : 'SELL',
      tokenAmount: amount(buy ? a.to_token_amount : a.from_token_amount, true),
      quoteAmount: amount(buy ? a.from_token_amount : a.to_token_amount, true),
      quoteMint,
      priceUsd: amount(rawPrice, true),
      volumeUsd: amount(a.volume_in_usd),
      usdReliable: true,
      usdSource: 'GECKOTERMINAL_TRADE_USD',
      usdObservedAt: a.block_timestamp,
      traderAddress: trader.success ? trader.data : null,
      transactionSignature: a.tx_hash,
      rawPayload: {
        providerId: row.id,
        providerPriceUsd: rawPrice,
        providerVolumeUsd: a.volume_in_usd,
        isAnomalous: a.is_anomalous,
      },
    });
    if (a.is_anomalous) anomalous.add(trade.id);
    trades.push(trade);
  }
  const oldest = Math.min(...trades.map((t) => Date.parse(t.timestamp)));
  const latest = trades.reduce<string | null>(
    (last, t) =>
      !last || Date.parse(t.timestamp) > Date.parse(last) ? t.timestamp : last,
    null,
  );
  const bars = new Map<number, string[]>();
  for (const row of barsSchema.parse(barInput).data.attributes.ohlcv_list) {
    if (!/^\d{1,12}$/.test(row[0]!))
      throw new FreeMarketError('FREE_MARKET_BAR_TIME_INVALID');
    const start = Number(row[0]) * 1000;
    if (!Number.isFinite(start) || start % 60000 !== 0 || bars.has(start))
      throw new FreeMarketError('FREE_MARKET_BAR_TIME_INVALID');
    bars.set(start, row);
  }
  const candles: MarketCandle[] = [];
  const end = Date.parse(coverageUntil);
  for (let start = end - 16 * 60000; start < end; start += 60000) {
    const row = bars.get(start);
    const current = trades.filter(
      (t) =>
        Date.parse(t.timestamp) >= start &&
        Date.parse(t.timestamp) < start + 60000,
    );
    const issues: string[] = [];
    if (!(oldest < start)) issues.push('FREE_TRADE_WINDOW_TRUNCATED');
    if (!row) issues.push('FREE_OHLCV_INTERVAL_UNAVAILABLE');
    if (current.some((t) => anomalous.has(t.id)))
      issues.push('FREE_ANOMALOUS_TRADE');
    if (current.some((t) => t.side === 'BUY' && t.traderAddress === null))
      issues.push('BUYER_IDENTITIES_UNAVAILABLE');
    const sum = (side?: 'BUY' | 'SELL') =>
      fromAtomic(
        current
          .filter((t) => !side || t.side === side)
          .reduce((total, t) => total + toAtomic(t.volumeUsd!), 0n),
      );
    const volume = sum();
    let open: string | null = null,
      high: string | null = null,
      low: string | null = null,
      close: string | null = null;
    if (row) {
      [open, high, low, close] = row
        .slice(1, 5)
        .map((v) => amount(v, true)) as [string, string, string, string];
      if (
        toAtomic(low) > toAtomic(high) ||
        toAtomic(open) < toAtomic(low) ||
        toAtomic(open) > toAtomic(high) ||
        toAtomic(close) < toAtomic(low) ||
        toAtomic(close) > toAtomic(high)
      )
        issues.push('FREE_OHLCV_PRICES_INVALID');
      const reported = toAtomic(amount(row[5]));
      const difference = reported - toAtomic(volume);
      // Two independently cached provider endpoints must reconcile within 0.1% or $0.00000001.
      const tolerance =
        reported / 1000n > 10000000000n ? reported / 1000n : 10000000000n;
      if ((difference < 0n ? -difference : difference) > tolerance)
        issues.push('FREE_VOLUME_COVERAGE_MISMATCH');
    }
    if (!current.length) issues.push('FREE_TRADES_UNAVAILABLE');
    const buyers = [
      ...new Set(
        current
          .filter((t) => t.side === 'BUY' && t.traderAddress !== null)
          .map((t) => t.traderAddress!),
      ),
    ].sort();
    const data = {
      mint,
      poolAddress: pool,
      startTime: iso(start),
      endTime: iso(start + 60000),
      open,
      high,
      low,
      close,
      volumeUsd: volume,
      buyVolumeUsd: sum('BUY'),
      sellVolumeUsd: sum('SELL'),
      tradeCount: current.length,
      buyers,
      uniqueBuyers: buyers.length,
      complete: issues.length === 0,
      issues,
      tradeIds: current.map((t) => t.id).sort(),
    };
    candles.push(
      marketCandleSchema.parse({
        ...data,
        id: stableId(['free-provider-candle-v1', data]),
        finalizedAt: receivedAt,
      }),
    );
  }
  return {
    mint,
    pool,
    quoteMint,
    poolCreatedAt,
    liquidityUsd,
    receivedAt,
    coverageUntil,
    lastTradeAt: latest,
    candles,
    trades,
  };
}
