import { describe, it, expect, vi } from 'vitest';
import { stableId } from '@solemn/shared';
import {
  GeckoPublicClient,
  freeDecimal,
  normalizeFreeSnapshot,
} from '../src/market/freeGeckoClient.js';
import {
  evaluateFreePaperSnapshot,
  freePaperProfile,
} from '../src/portfolio/freePaperDecisions.js';
import { initialStrategyState } from '../src/strategy/signalEngine.js';
import { geckoTerminalBaseUrlSchema, loadConfig } from '../src/config/index.js';
import { paperConfig } from './paperFixtures.js';
import { freeSnapshot, fixtureRisk } from './freeLiveFixtures.js';
import { MINT, OTHER_MINT } from '../../../tests/fixtures.js';
const pool = '11111111111111111111111111111111';
const base = Date.parse('2026-01-01T00:00:00.000Z');
function providerData() {
  const rows = [],
    bars = [];
  for (let m = -1; m < 16; m++) {
    for (const side of ['buy', 'sell'] as const)
      rows.push({
        id: 'trade-' + m + '-' + side,
        attributes: {
          block_timestamp: new Date(base + m * 60000 + 1000).toISOString(),
          tx_hash: '1'.repeat(64),
          tx_from_address: MINT,
          kind: side,
          from_token_address: side === 'buy' ? OTHER_MINT : MINT,
          to_token_address: side === 'buy' ? MINT : OTHER_MINT,
          from_token_amount: '1',
          to_token_amount: '1',
          price_from_in_usd: '1',
          price_to_in_usd: '1',
          volume_in_usd: '1',
          is_anomalous: false,
        },
      });
    if (m >= 0)
      bars.push([String(base / 1000 + m * 60), '1', '1', '1', '1', '2']);
  }
  return {
    trade: { data: rows },
    bar: { data: { attributes: { ohlcv_list: bars } } },
  };
}
const normalize = (trade: unknown, bar: unknown) =>
  normalizeFreeSnapshot(
    MINT,
    pool,
    OTHER_MINT,
    new Date(base - 120000).toISOString(),
    '50000',
    trade,
    bar,
    new Date(base + 18 * 60000).toISOString(),
    new Date(base + 16 * 60000).toISOString(),
  );
describe('free public market adapter', () => {
  it('pins an existing position to its original pool and still observes reduced liquidity for protective exits', async () => {
    const data = providerData();
    let clock = base + 18 * 60000;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = String(url);
      const body = path.endsWith('/pools')
        ? {
            data: [
              ...[pool, MINT].map((address, i) => ({
                attributes: {
                  address,
                  pool_created_at: new Date(base - 120000).toISOString(),
                  reserve_in_usd: i ? '1' : '50000',
                },
                relationships: {
                  base_token: { data: { id: 'solana_' + MINT } },
                  quote_token: { data: { id: 'solana_' + OTHER_MINT } },
                },
              })),
            ],
          }
        : path.includes('/ohlcv/')
          ? data.bar
          : data.trade;
      return new Response(JSON.stringify(body));
    });
    const client = new GeckoPublicClient(
      paperConfig,
      fetcher,
      () => (clock += 7001),
    );
    const result = await client.read(MINT, new AbortController().signal, MINT);
    expect(result.pool).toBe(MINT);
    expect(result.liquidityUsd).toBe('1');
    expect(
      fetcher.mock.calls
        .slice(1)
        .every(([url]) => String(url).includes('/pools/' + MINT + '/')),
    ).toBe(true);
    expect(fetcher.mock.calls[2]![0]).toContain('/trades?');
  });
  it('keeps provider decimals out of Number, with explicit downward quantization', () => {
    expect(freeDecimal('1.23456789012345678999')).toBe('1.234567890123456789');
    expect(freeDecimal('1.234e-8')).toBe('0.00000001234');
    expect(freeDecimal('9007199254740993')).toBe('9007199254740993');
    expect(freeDecimal('-1')).toBeNull();
  });
  it('builds complete USD candles with real side volume and buyer identities', () => {
    const data = providerData();
    const result = normalize(data.trade, data.bar);
    expect(result.candles).toHaveLength(16);
    expect(
      result.candles.every((c) => c.complete && c.issues.length === 0),
    ).toBe(true);
    expect(result.candles[0]).toMatchObject({
      volumeUsd: '2',
      buyVolumeUsd: '1',
      sellVolumeUsd: '1',
      uniqueBuyers: 1,
    });
  });
  it('blocks a truncated trade page and inconsistent OHLCV volume', () => {
    const data = providerData();
    data.trade.data = data.trade.data.filter(
      (row) =>
        row.attributes.block_timestamp >=
        new Date(base + 10 * 60000).toISOString(),
    );
    data.bar.data.attributes.ohlcv_list.at(-1)![5] = '999';
    const result = normalize(data.trade, data.bar);
    expect(result.candles[0]?.issues).toContain('FREE_TRADE_WINDOW_TRUNCATED');
    expect(result.candles.at(-1)?.issues).toContain(
      'FREE_VOLUME_COVERAGE_MISMATCH',
    );
  });
  it('refuses missing buyer identity, anomalous trades, and cross-pool token mismatches', () => {
    const data = providerData();
    data.trade.data.at(-2)!.attributes.tx_from_address = '';
    data.trade.data.at(-1)!.attributes.is_anomalous = true;
    const result = normalize(data.trade, data.bar);
    expect(result.candles.at(-1)?.issues).toEqual(
      expect.arrayContaining([
        'BUYER_IDENTITIES_UNAVAILABLE',
        'FREE_ANOMALOUS_TRADE',
      ]),
    );
    data.trade.data[0]!.attributes.from_token_address = MINT;
    expect(() => normalize(data.trade, data.bar)).toThrow(
      'FREE_MARKET_TRADE_SCOPE_MISMATCH',
    );
  });
  it('pins the free host and validates startup mode, flags and request limits', () => {
    expect(
      geckoTerminalBaseUrlSchema.safeParse(
        'https://pro-api.coingecko.com/api/v2',
      ).success,
    ).toBe(false);
    expect(
      geckoTerminalBaseUrlSchema.safeParse(
        'https://api.geckoterminal.com/api/v2?api-key=secret',
      ).success,
    ).toBe(false);
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        LIVE_PAPER_DECISIONS_ENABLED: 'true',
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        FREE_MARKET_REQUEST_INTERVAL_MS: '10',
      }),
    ).toThrow();
  });
  it('uses only public GET endpoints, and honours rate-limit failures without extra retries', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
      );
    const client = new GeckoPublicClient(paperConfig, fetcher);
    await expect(
      client.read(MINT, new AbortController().signal),
    ).rejects.toThrow('RATE_LIMITED');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.geckoterminal.com/api/v2/networks/solana/tokens/' +
        MINT +
        '/pools',
    );
    expect(init?.method).toBe('GET');
    expect(JSON.stringify(init?.headers)).not.toMatch(/key|authorization/i);
  });
});
describe('live paper signal gates', () => {
  it('generates a live-labelled BUY only after a separate spike, pullback and breakout', () => {
    let state = initialStrategyState();
    let decision;
    for (const end of [12, 13, 14]) {
      const input = freeSnapshot(paperConfig, end);
      decision = evaluateFreePaperSnapshot(
        paperConfig,
        stableId(['live-test']),
        input,
        fixtureRisk(paperConfig, input.receivedAt),
        state,
        input.receivedAt,
      );
      state = decision.stateAfter;
    }
    expect(decision?.outcome).toBe('BUY_CANDIDATE');
    expect(decision?.candidate?.dataMode).toBe('LIVE_PAPER');
    expect(decision?.candidate?.explanation).toContain(
      'Live market paper-entry decision',
    );
  });
  it('keeps unknown risk, stale prices and incomplete windows out of live entries', () => {
    const input = freeSnapshot(paperConfig, 14);
    const run = stableId(['live-test']);
    expect(
      evaluateFreePaperSnapshot(
        paperConfig,
        run,
        input,
        null,
        initialStrategyState(),
        input.receivedAt,
      ).outcome,
    ).toBe('BLOCKED_BY_RISK');
    input.lastTradeAt = new Date(base).toISOString();
    input.candles.at(-1)!.issues = ['FREE_VOLUME_COVERAGE_MISMATCH'];
    expect(
      evaluateFreePaperSnapshot(
        paperConfig,
        run,
        input,
        fixtureRisk(paperConfig, input.receivedAt),
        initialStrategyState(),
        input.receivedAt,
      ),
    ).toMatchObject({ outcome: 'INSUFFICIENT_DATA', candidate: null });
  });
  it('keeps a stable account across restarts, with a new profile after policy changes', () => {
    const first = freePaperProfile(paperConfig, new Date(base).toISOString());
    expect(
      freePaperProfile(paperConfig, new Date(base + 60000).toISOString())
        .definition.id,
    ).toBe(first.definition.id);
    expect(
      freePaperProfile(
        { ...paperConfig, STRATEGY_MIN_UNIQUE_BUYERS_5M: 41 },
        new Date(base).toISOString(),
      ).definition.id,
    ).not.toBe(first.definition.id);
  });
});
