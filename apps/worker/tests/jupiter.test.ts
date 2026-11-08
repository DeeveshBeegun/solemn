import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddressDecoder } from '@solana/kit';
import { loadConfig } from '../src/config/index.js';
import { JupiterTokenClient } from '../src/analysis/jupiterTokenClient.js';
import { providerDecimal } from '../src/analysis/observations.js';
import { jupiterPayload, MINT, NOW, OTHER_MINT } from './riskFixtures.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://localhost/solemn',
  JUPITER_TOKENS_BASE_URL: 'http://127.0.0.1:1234/tokens/v2',
  JUPITER_REQUEST_INTERVAL_MS: '1',
  RISK_HTTP_MAX_ATTEMPTS: '1',
});
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
describe('Jupiter V2 runtime contract', () => {
  it('splits batches at 100 and preserves optional activity statistics', async () => {
    const mints = Array.from({ length: 101 }, (_, index) =>
      String(getAddressDecoder().decode(new Uint8Array(32).fill(index + 1))),
    );
    const sizes: number[] = [];
    const client = new JupiterTokenClient(config, async (url) => {
      const requested =
        new URL(String(url)).searchParams.get('query')?.split(',') ?? [];
      sizes.push(requested.length);
      return new Response(
        JSON.stringify(
          requested.map((mint) => ({
            ...jupiterPayload(mint),
            stats5m: { buyVolume: 0.1, numBuys: 3 },
          })),
        ),
      );
    });
    const result = await client.getMany(mints, signal());
    expect(sizes).toEqual([100, 1]);
    expect(result.size).toBe(101);
    expect(result.get(mints[0] as string)?.activity).toEqual({
      stats5m: { buyVolume: '0.1', numBuys: '3' },
    });
  });
  it('validates exact mint matches, batches and caches successful immutable observations', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify([jupiterPayload(), jupiterPayload(OTHER_MINT)]),
          ),
      );
    const client = new JupiterTokenClient(config, fetcher, undefined, () =>
      Date.parse(NOW),
    );
    const result = await client.getMany([MINT, OTHER_MINT], signal());
    expect(result.get(MINT)?.state).toBe('OK');
    expect(result.get(MINT)?.liquidityUsd).toBe('50000');
    expect(
      new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('query'),
    ).toBe(`${MINT},${OTHER_MINT}`);
    const first = result.get(MINT);
    if (first) first.liquidityUsd = '0';
    expect(
      (await client.getMany([MINT], signal())).get(MINT)?.liquidityUsd,
    ).toBe('50000');
    expect(fetcher).toHaveBeenCalledOnce();
    client.invalidate(MINT);
    fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify([jupiterPayload()])),
    );
    await client.getMany([MINT], signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('coalesces simultaneous requests for a mint', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify([jupiterPayload()])),
      );
    const client = new JupiterTokenClient(config, fetcher);
    const [a, b] = await Promise.all([
      client.getMany([MINT], signal()),
      client.getMany([MINT], signal()),
    ]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    ['[]', 'MISSING', null],
    ['{', 'ERROR', 'INVALID_RESPONSE'],
    [JSON.stringify([jupiterPayload(OTHER_MINT)]), 'ERROR', 'MINT_MISMATCH'],
    [JSON.stringify([{ ...jupiterPayload(), audit: undefined }]), 'OK', null],
  ])(
    'handles missing, malformed, mismatched or incomplete responses',
    async (body, state, errorCode) => {
      const client = new JupiterTokenClient(
        config,
        async () => new Response(body),
      );
      const result = (await client.getMany([MINT], signal())).get(MINT);
      expect(result?.state).toBe(state);
      expect(result?.error?.code ?? null).toBe(errorCode);
      if (!body.includes('audit'))
        expect(result?.mintAuthorityDisabled).toBeNull();
    },
  );
  it('preserves decimal numeric literals and nullable suspicious flags without rounding', async () => {
    const raw = JSON.stringify([
      { ...jupiterPayload(), audit: { topHoldersPercentage: 20 } },
    ]).replace('"liquidity":50000', '"liquidity":40000.000000000000000001');
    const client = new JupiterTokenClient(
      config,
      async () => new Response(raw),
    );
    const result = (await client.getMany([MINT], signal())).get(MINT);
    expect(result?.liquidityUsd).toBe('40000.000000000000000001');
    expect(result?.isSus).toBeNull();
    expect(result?.rawResponse).toBe(raw);
    expect(providerDecimal('1e-7')).toBe('0.0000001');
    expect(providerDecimal('1e-19')).toBeNull();
  });
  it('honors 429 cooldowns with bounded retries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('ignored secret error', {
          status: 429,
          headers: { 'retry-after': '0.05' },
        }),
      )
      .mockImplementation(
        async () => new Response(JSON.stringify([jupiterPayload()])),
      );
    const limited = vi.fn();
    const client = new JupiterTokenClient(
      { ...config, RISK_HTTP_MAX_ATTEMPTS: 2, RISK_HTTP_RETRY_MS: 1 },
      fetcher,
      limited,
    );
    const pending = client.getMany([MINT], signal());
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).get(MINT)?.state).toBe('OK');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(limited).toHaveBeenCalledOnce();
  });
  it('aborts timeouts and stores no HTTP error body', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('secret timeout')),
          { once: true },
        ),
      );
    const client = new JupiterTokenClient(
      { ...config, RISK_HTTP_TIMEOUT_MS: 10 },
      fetcher,
    );
    const pending = client.getMany([MINT], signal());
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).get(MINT)?.error?.code).toBe('TIMEOUT');
    const denied = new JupiterTokenClient(
      config,
      async () => new Response('SECRET_API_KEY', { status: 403 }),
    );
    const denial = denied.getMany([MINT], signal());
    await vi.advanceTimersByTimeAsync(100);
    expect((await denial).get(MINT)?.rawResponse).toBeNull();
    expect((await denial).get(MINT)?.error?.code).toBe('AUTHENTICATION');
  });
  it('spaces concurrent batches according to the request budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const times: number[] = [];
    const fetcher: typeof fetch = async (url) => {
      times.push(Date.now());
      const mint = new URL(String(url)).searchParams.get('query') as string;
      return new Response(JSON.stringify([jupiterPayload(mint)]));
    };
    const client = new JupiterTokenClient(
      { ...config, JUPITER_REQUEST_INTERVAL_MS: 100 },
      fetcher,
    );
    const pending = Promise.all([
      client.getMany([MINT], signal()),
      client.getMany([OTHER_MINT], signal()),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(100);
  });
});
