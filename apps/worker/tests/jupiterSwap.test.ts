import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  effectiveRate,
  fromBaseUnits,
  swapRequestSchema,
  toBaseUnits,
  wrappedSol,
} from '../src/execution/jupiter/amounts.js';
import { JupiterSwapClient } from '../src/execution/jupiter/jupiterClient.js';
import {
  quoteFreshness,
  validateQuote,
} from '../src/execution/jupiter/quoteValidation.js';
import { estimateSwapFees } from '../src/execution/feeEstimator.js';
import {
  computeBudgetProgram,
  inspectTransaction,
} from '../src/execution/jupiter/transactionInspector.js';
import { TransactionSimulator } from '../src/execution/jupiter/transactionSimulator.js';
import {
  address,
  opaqueSwapFixture,
  providerQuote,
  quoteRequest,
  swapConfig,
  taker,
  unsignedFixture,
} from './jupiterFixtures.js';

const now = Date.parse('2026-11-09T10:00:00.000Z');
const response = (value: unknown) => new Response(JSON.stringify(value));
const jupiter = (value: unknown) =>
  new JupiterSwapClient(
    swapConfig,
    async () => response(value),
    () => now,
  );
const simulated = (err: unknown, logs: string[] | null = null) => ({
  jsonrpc: '2.0',
  id: 1,
  result: {
    context: { slot: 700 },
    value: { err, logs, unitsConsumed: 540, fee: 5000 },
  },
});
afterEach(() => vi.useRealTimers());

describe('Exact Jupiter amounts', () => {
  it('round-trips u64 and high-decimal base units losslessly', () => {
    expect(toBaseUnits('18446744073.709551615', 9)).toBe(
      '18446744073709551615',
    );
    expect(fromBaseUnits('18446744073709551615', 9)).toBe(
      '18446744073.709551615',
    );
    const tiny = '0.' + '0'.repeat(254) + '1';
    expect(toBaseUnits(tiny, 255)).toBe('1');
    expect(fromBaseUnits('1', 255)).toBe(tiny);
    expect(
      JSON.stringify({ units: toBaseUnits('9007199254740993', 0) }),
    ).toContain('"9007199254740993"');
    expect(effectiveRate(quoteRequest, '865209').decimalTruncated18).toBe(
      '86.5209',
    );
  });

  it.each([
    ['0', 9],
    ['-1', 9],
    ['0.0000000001', 9],
    ['18446744073709551616', 0],
    ['1', 256],
  ])('rejects %s at precision %s', (amount, decimals) => {
    expect(() => toBaseUnits(amount, decimals)).toThrow();
  });

  it('checks known mint precision and distinct endpoints', () => {
    expect(
      swapRequestSchema.safeParse({ ...quoteRequest, inputDecimals: 8 })
        .success,
    ).toBe(false);
    expect(
      swapRequestSchema.safeParse({ ...quoteRequest, outputMint: wrappedSol })
        .success,
    ).toBe(false);
  });
  it('canonicalizes an unset optional CLI slippage field before hashing', async () => {
    const request = swapRequestSchema.parse({
      ...quoteRequest,
      slippageBps: undefined,
    });
    expect(Object.hasOwn(request, 'slippageBps')).toBe(false);
    expect(await jupiter(providerQuote()).order(request)).toMatchObject({
      status: 'QUOTED',
    });
  });
});

describe('Jupiter GET-only client', () => {
  it('deduplicates concurrent requests and sends only documented quote fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(providerQuote()));
    const client = new JupiterSwapClient(
      {
        ...swapConfig,
        JUPITER_TAKER_PUBLIC_KEY: taker,
        JUPITER_API_KEY: 'ignored-at-loopback',
      },
      fetcher,
      () => now,
    );
    const [first, second] = await Promise.all([
      client.order(quoteRequest),
      client.order(quoteRequest),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: 'QUOTED',
      unsignedTransaction: null,
      quote: {
        transactionStatus: 'QUOTE_ONLY',
        outAmount: '800000',
        signatureFeeLamports: '5000',
        source: 'LOOPBACK_TEST',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [href, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(href));
    expect(url.pathname).toBe('/swap/v2/order');
    expect(url.searchParams.has('taker')).toBe(false);
    expect(url.searchParams.get('amount')).toBe('10000000');
    expect(url.searchParams.get('maxSupportedTransactionVersion')).toBe('0');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {},
    });
    expect(JSON.stringify(first)).not.toContain('Untrusted text');
  });

  it('sends the documented auth header only to the official API', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(
        providerQuote(quoteRequest, { requestId: 'echo-test-auth-secret' }),
      ),
    );
    const client = new JupiterSwapClient(
      {
        ...swapConfig,
        JUPITER_SWAP_BASE_URL: 'https://api.jup.ag/swap/v2',
        JUPITER_API_KEY: 'test-auth-secret',
      },
      fetcher,
      () => now,
    );
    expect(await client.order(quoteRequest)).toMatchObject({
      status: 'QUOTED',
      quote: { requestId: null },
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-api-key': 'test-auth-secret' },
    });
  });
  it('refuses alternate request paths and origins even without the environment parser', () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const base of [
      'https://api.jup.ag/swap/v2/execute',
      'https://example.com/swap/v2',
    ]) {
      expect(
        () =>
          new JupiterSwapClient(
            { ...swapConfig, JUPITER_SWAP_BASE_URL: base },
            fetcher,
          ),
      ).toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not contact providers for malformed input or unenabled builds', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new JupiterSwapClient(swapConfig, fetcher);
    expect(
      await client.order({ ...quoteRequest, inputMint: 'fake' }),
    ).toMatchObject({ reason: 'INVALID_SWAP_REQUEST' });
    expect(await client.order({ ...quoteRequest, amount: '0' })).toMatchObject({
      reason: 'INVALID_SWAP_REQUEST',
    });
    expect(await client.order(quoteRequest, 'prepare')).toMatchObject({
      reason: 'UNSIGNED_BUILD_DISABLED_OR_TAKER_MISSING',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'INVALID_PROVIDER_RESPONSE'],
    [providerQuote(quoteRequest, { routePlan: [] }), 'NO_ROUTE'],
    [
      providerQuote(quoteRequest, { outputMint: address(72) }),
      'ORDER_REQUEST_MISMATCH',
    ],
    [
      providerQuote(quoteRequest, { inAmount: 10000000 }),
      'INVALID_PROVIDER_RESPONSE',
    ],
    [providerQuote(quoteRequest, { router: 'new-router' }), 'UNKNOWN_ROUTER'],
    [
      providerQuote(quoteRequest, {
        routePlan: providerQuote({ ...quoteRequest, outputMint: address(69) })
          .routePlan,
      }),
      'UNSUPPORTED_ROUTE',
    ],
  ])(
    'rejects malformed, mismatched or unsupported responses (%s)',
    async (body, reason) => {
      expect(await jupiter(body).order(quoteRequest)).toMatchObject({ reason });
    },
  );

  it('distinguishes route errors, authentication, rate limit and malformed JSON', async () => {
    const run = (result: Response) =>
      new JupiterSwapClient(
        swapConfig,
        async () => result,
        () => now,
      ).order(quoteRequest);
    expect(
      await run(
        new Response(
          '{"error":"Could not find a route","requestId":"fixture"}',
          { status: 400 },
        ),
      ),
    ).toMatchObject({ status: 'UNSUPPORTED', reason: 'NO_ROUTE' });
    expect(await run(new Response('secret', { status: 401 }))).toMatchObject({
      reason: 'AUTHENTICATION',
    });
    expect(
      await run(
        new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
      ),
    ).toMatchObject({
      reason: 'RATE_LIMITED',
      retryAt: new Date(now + 120000).toISOString(),
    });
    expect(await run(new Response('{'))).toMatchObject({
      reason: 'MALFORMED_JSON',
    });
  });

  it('bounds repeated timeouts and request spacing', async () => {
    vi.useFakeTimers({ now });
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const client = new JupiterSwapClient(
      { ...swapConfig, JUPITER_QUOTE_TIMEOUT_MS: 10 },
      fetcher,
      Date.now,
    );
    const pending = client.order(quoteRequest);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await pending).toMatchObject({ reason: 'TIMEOUT' });
  });

  it('distinguishes a valid price whose unsigned build failed', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(
        providerQuote(quoteRequest, {
          transaction: '',
          taker,
          errorCode: 2,
          errorMessage: 'excluded raw error',
        }),
      ),
    );
    const client = new JupiterSwapClient(
      {
        ...swapConfig,
        JUPITER_UNSIGNED_BUILD_ENABLED: true,
        JUPITER_TAKER_PUBLIC_KEY: taker,
      },
      fetcher,
      () => now,
    );
    const result = await client.order(quoteRequest, 'prepare');
    expect(result).toMatchObject({
      status: 'QUOTED',
      quote: { transactionStatus: 'BUILD_UNAVAILABLE', errorCode: '2' },
    });
    expect(
      new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('taker'),
    ).toBe(taker);
    expect(JSON.stringify(result)).not.toContain('excluded raw error');
  });
});

describe('Quote validation and cost separation', () => {
  async function quote(overrides: Record<string, unknown> = {}) {
    const result = await jupiter(providerQuote(quoteRequest, overrides)).order(
      quoteRequest,
    );
    if (result.status !== 'QUOTED') throw new Error(result.reason);
    return result.quote;
  }
  it('uses exact fee and slippage fields and treats rent as potentially recoverable', async () => {
    const q = await quote({ rentFeeLamports: 2039280, rentFeePayer: taker });
    expect(validateQuote(q, swapConfig).status).toBe('READY_FOR_DRY_RUN');
    expect(estimateSwapFees(q, '80')).toMatchObject({
      estimatedSolDebitsUpperBoundUsd: '0.1636224',
      totalCostComplete: false,
      embedded: { totalProviderFeeBps: 5, feeMint: wrappedSol },
      fees: expect.arrayContaining([
        expect.objectContaining({
          category: 'RENT_DEPOSIT',
          treatment: 'POTENTIALLY_RECOVERABLE',
        }),
      ]),
    });
    expect(
      estimateSwapFees(q, null).estimatedSolDebitsUpperBoundUsd,
    ).toBeNull();
  });

  it.each([
    [{ feeBps: 201 }, 'FEE_BPS_EXCEEDED'],
    [{ priceImpact: -5.01 }, 'PRICE_IMPACT_EXCEEDED'],
    [{ otherAmountThreshold: '700000' }, 'SLIPPAGE_PROTECTION_INVALID'],
    [{ feeMint: address(92) }, 'FEE_MINT_UNPRICED'],
    [{ priceImpact: null }, 'QUOTE_COST_EVIDENCE_MISSING'],
  ])(
    'rejects missing or out-of-policy quote evidence (%s)',
    async (fields, reason) => {
      expect(validateQuote(await quote(fields), swapConfig).reason).toBe(
        reason,
      );
    },
  );

  it('checks age, explicit RFQ expiry and inclusive last valid block height', async () => {
    const q = await quote({
      lastValidBlockHeight: '99',
      expireAt: new Date(now + 500).toISOString(),
    });
    expect(quoteFreshness(q, now, 1000).reason).toBe('BLOCK_HEIGHT_UNVERIFIED');
    expect(quoteFreshness(q, now, 1000, 99n).status).toBe('READY_FOR_DRY_RUN');
    expect(quoteFreshness(q, now, 1000, 100n).reason).toBe(
      'BLOCK_HEIGHT_EXCEEDED',
    );
    expect(quoteFreshness(q, now + 500, 1000, 99n).reason).toBe('RFQ_EXPIRED');
    expect(quoteFreshness(await quote(), now + 1000, 1000).reason).toBe(
      'QUOTE_AGE_EXCEEDED',
    );
  });
});

describe('Unsigned transaction inspection', () => {
  it('inspects v0 and legacy structure and never calls a swap safe on program identity alone', () => {
    expect(inspectTransaction(unsignedFixture(), taker, 0)).toMatchObject({
      status: 'INSPECTED',
      version: 0,
      feePayer: taker,
      requiredSigners: [taker],
      programs: [computeBudgetProgram],
    });
    expect(
      inspectTransaction(unsignedFixture({ version: 'legacy' }), taker).version,
    ).toBe('legacy');
    expect(inspectTransaction(opaqueSwapFixture(), taker)).toMatchObject({
      status: 'UNSUPPORTED',
      diagnosticSimulationAllowed: true,
      reason: 'JUPITER_CPI_AND_TOKEN_ACCOUNTS_UNVERIFIED',
    });
  });
  it.each([
    [{ payer: address(94) }, 'UNEXPECTED_FEE_PAYER_OR_SIGNER'],
    [{ signed: true }, 'NONZERO_SIGNATURE'],
    [{ lookup: true }, 'ADDRESS_LOOKUP_TABLES_UNRESOLVED'],
    [{ program: address(77) }, 'UNKNOWN_PROGRAM'],
    [{ program: address(0) }, 'DIRECT_TOKEN_SOL_OR_ATA_INSTRUCTION_UNVERIFIED'],
    [{ badBlockhash: true }, 'MISSING_RECENT_BLOCKHASH'],
  ])(
    'fails closed for unsafe or unresolved structure (%s)',
    (options, reason) => {
      expect(inspectTransaction(unsignedFixture(options), taker).reason).toBe(
        reason,
      );
    },
  );
  it('rejects unsupported versions and missing signature slots', () => {
    expect(inspectTransaction(unsignedFixture(), taker, 1).reason).toBe(
      'UNSUPPORTED_TRANSACTION_VERSION',
    );
    const bytes = Buffer.from(unsignedFixture(), 'base64');
    bytes[0] = 0;
    expect(inspectTransaction(bytes.toString('base64'), taker).reason).toBe(
      'EXPECTED_SINGLE_SIGNATURE_SLOT',
    );
  });
  it('blocks RPC admission if the transaction declares a different mint from the quote', () => {
    expect(
      inspectTransaction(opaqueSwapFixture(), taker, 0, {
        ...quoteRequest,
        outputMint: address(61),
      }),
    ).toMatchObject({
      status: 'REJECTED',
      reason: 'TRANSACTION_MINTS_DO_NOT_MATCH_QUOTE',
      diagnosticSimulationAllowed: false,
    });
  });
});

describe('Read-only Solana simulation', () => {
  const config = {
    ...swapConfig,
    JUPITER_RPC_SIMULATION_ENABLED: true,
    SOLANA_RPC_URL: 'http://localhost:1234/rpc',
  };
  it('cannot repurpose the simulation endpoint to contact Jupiter', () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      () =>
        new TransactionSimulator(
          {
            ...config,
            SOLANA_RPC_URL: 'https://api.jup.ag/swap/v2/execute',
          },
          fetcher,
        ),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses only simulation with the original blockhash and redacts free-text logs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(
        simulated(null, [
          'Program log: untrusted text',
          'Program ' + computeBudgetProgram + ' success',
        ]),
      ),
    );
    const result = await new TransactionSimulator(
      config,
      fetcher,
      () => now,
    ).simulate(unsignedFixture(), taker);
    expect(result).toMatchObject({
      status: 'SIMULATED',
      slot: '700',
      unitsConsumed: '540',
      estimatedFeeLamports: '5000',
      logs: ['Program ' + computeBudgetProgram + ' success'],
    });
    const call = fetcher.mock.calls[0]?.[1];
    expect(call).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(call?.body))).toMatchObject({
      method: 'simulateTransaction',
      params: [
        unsignedFixture(),
        {
          sigVerify: false,
          replaceRecentBlockhash: false,
          encoding: 'base64',
          commitment: 'confirmed',
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['BlockhashNotFound', 'BlockhashNotFound'],
    ['AccountNotFound', 'AccountNotFound'],
    [
      { InstructionError: [0, 'ComputationalBudgetExceeded'] },
      'InstructionError:ComputationalBudgetExceeded',
    ],
    [{ InstructionError: [0, { Custom: 42 }] }, 'InstructionError:Custom:42'],
  ])('records RPC transaction failure %s', async (error, code) => {
    const rpc = new TransactionSimulator(
      config,
      async () => response(simulated(error)),
      () => now,
    );
    expect(await rpc.simulate(unsignedFixture(), taker)).toMatchObject({
      status: 'SIMULATION_FAILED',
      programError: code,
      logsAvailable: false,
    });
  });

  it('reports missing logs and unavailable RPC without fabricating execution', async () => {
    const rpc = new TransactionSimulator(
      config,
      async () => response(simulated(null)),
      () => now,
    );
    expect(await rpc.simulate(unsignedFixture(), taker)).toMatchObject({
      status: 'SIMULATED',
      logsAvailable: false,
    });
    const unavailable = new TransactionSimulator(
      config,
      async () => new Response(null, { status: 503 }),
      () => now,
    );
    expect(await unavailable.simulate(unsignedFixture(), taker)).toMatchObject({
      status: 'UNVERIFIABLE',
      attempted: true,
    });
    const fetcher = vi.fn<typeof fetch>();
    const blocked = new TransactionSimulator(config, fetcher, () => now);
    expect(
      await blocked.simulate(unsignedFixture({ signed: true }), taker),
    ).toMatchObject({ attempted: false });
    expect(await blocked.simulate(unsignedFixture(), taker, now)).toMatchObject(
      { attempted: false },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
