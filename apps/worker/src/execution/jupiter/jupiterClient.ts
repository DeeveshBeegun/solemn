import { isLosslessNumber, parse } from 'lossless-json';
import { mintAddressSchema, stableId } from '@solemn/shared';
import { z } from 'zod';
import { HttpReader, providerError } from '../../analysis/httpReader.js';
import { providerDecimal } from '../../analysis/observations.js';
import { jupiterSwapBaseUrlSchema } from '../../config/index.js';
import type { Config } from '../../config/index.js';
import {
  effectiveRate,
  fromBaseUnits,
  positiveUnits,
  routerSchema,
  swapRequestSchema,
  unitsSchema,
} from './amounts.js';
import type { SwapRequest } from './amounts.js';

export const uintFromJson = z.preprocess(
  (value) => (isLosslessNumber(value) ? value.value : undefined),
  unitsSchema,
);
const bps = uintFromJson
  .refine((value) => Number(value) <= 10000)
  .transform(Number);
const providerNumber = z.preprocess(
  (value) => (isLosslessNumber(value) ? providerDecimal(value.value) : null),
  z.string().nullable(),
);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
const impact = z.preprocess((value) => {
  if (!isLosslessNumber(value)) return null;
  const negative = value.value.startsWith('-');
  const magnitude = providerDecimal(
    negative ? value.value.slice(1) : value.value,
  );
  return magnitude === null
    ? null
    : (negative && magnitude !== '0' ? '-' : '') + magnitude;
}, z.string());
const routeLeg = z.object({
  swapInfo: z
    .object({
      ammKey: mintAddressSchema,
      inputMint: mintAddressSchema,
      outputMint: mintAddressSchema,
      inAmount: positiveUnits,
      outAmount: positiveUnits,
    })
    .refine((leg) => leg.inputMint !== leg.outputMint),
  bps: bps.optional(),
  percent: bps.refine((value) => value <= 100).optional(),
});
const responseSchema = z.object({
  inputMint: mintAddressSchema,
  outputMint: mintAddressSchema,
  inAmount: positiveUnits,
  outAmount: positiveUnits,
  otherAmountThreshold: unitsSchema,
  swapMode: z.literal('ExactIn'),
  slippageBps: bps,
  priceImpact: impact.nullish(),
  routePlan: z.array(routeLeg).min(1).max(64),
  router: routerSchema,
  mode: z.enum(['ultra', 'manual']).optional(),
  requestId: id.nullish(),
  quoteId: id.nullish(),
  expireAt: timestamp.nullish(),
  lastValidBlockHeight: unitsSchema.nullish(),
  transactionVersion: uintFromJson
    .transform(Number)
    .refine(Number.isSafeInteger)
    .nullish(),
  transaction: z.string().max(5500).nullish(),
  taker: mintAddressSchema.nullish(),
  feeMint: mintAddressSchema.nullish(),
  feeBps: bps.nullish(),
  platformFee: z
    .object({
      feeMint: mintAddressSchema.nullish(),
      feeBps: bps.nullish(),
      amount: unitsSchema.nullish(),
    })
    .nullish(),
  signatureFeeLamports: uintFromJson.nullish(),
  signatureFeePayer: mintAddressSchema.nullish(),
  prioritizationFeeLamports: uintFromJson.nullish(),
  prioritizationFeePayer: mintAddressSchema.nullish(),
  rentFeeLamports: uintFromJson.nullish(),
  rentFeePayer: mintAddressSchema.nullish(),
  gasless: z.boolean().nullish(),
  errorCode: uintFromJson.nullish(),
  totalTime: providerNumber.optional(),
  inUsdValue: providerNumber.optional(),
  outUsdValue: providerNumber.optional(),
});
type ProviderQuote = z.infer<typeof responseSchema>;
export type SwapQuote = Omit<ProviderQuote, 'transaction' | 'quoteId'> & {
  id: string;
  providerQuoteId: string | null;
  provider: 'JUPITER';
  apiVersion: 'v2';
  quotedAt: string;
  requestedAt: string;
  applicationValidUntil: string;
  inputAmount: string;
  expectedOutputAmount: string;
  latencyMs: number;
  routeAvailable: true;
  transactionStatus: 'QUOTE_ONLY' | 'BUILD_UNAVAILABLE' | 'AVAILABLE';
  effectiveOutputPerInput: ReturnType<typeof effectiveRate>;
  source: 'JUPITER_LIVE' | 'LOOPBACK_TEST';
};
export type QuoteResult =
  | { status: 'QUOTED'; quote: SwapQuote; unsignedTransaction: string | null }
  | {
      status: 'REJECTED' | 'INSUFFICIENT_DATA' | 'UNSUPPORTED';
      reason: string;
      httpStatus?: number | null;
      retryAt?: string | null;
      providerRequestId?: string | null;
      latencyMs?: number;
    };

function routeConnects(quote: ProviderQuote): boolean {
  if (quote.routePlan.length === 1) {
    const leg = quote.routePlan[0]!.swapInfo;
    return (
      leg.inputMint === quote.inputMint &&
      leg.outputMint === quote.outputMint &&
      leg.inAmount === quote.inAmount &&
      leg.outAmount === quote.outAmount
    );
  }
  const reachable = (root: string, reverse: boolean) => {
    const visited = new Set([root]);
    for (let pass = 0; pass < quote.routePlan.length; pass++)
      for (const { swapInfo: leg } of quote.routePlan) {
        const [from, to] = reverse
          ? [leg.outputMint, leg.inputMint]
          : [leg.inputMint, leg.outputMint];
        if (visited.has(from)) visited.add(to);
      }
    return visited;
  };
  const fromInput = reachable(quote.inputMint, false);
  const toOutput = reachable(quote.outputMint, true);
  return quote.routePlan.every(
    ({ swapInfo: leg }) =>
      leg.inputMint !== quote.outputMint &&
      leg.outputMint !== quote.inputMint &&
      fromInput.has(leg.inputMint) &&
      toOutput.has(leg.outputMint),
  );
}

const errorEnvelope = z.object({
  requestId: id.nullish(),
  error: z.string().max(1024).optional(),
  routePlan: z.array(z.unknown()).max(64).optional(),
  outAmount: unitsSchema.optional(),
  router: z.string().max(32).optional(),
});

export class JupiterSwapClient {
  readonly #origin: string;
  private readonly reader: HttpReader;
  private readonly inFlight = new Map<string, Promise<QuoteResult>>();
  readonly source: SwapQuote['source'];

  constructor(
    private readonly config: Config,
    fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.#origin = new URL(
      jupiterSwapBaseUrlSchema.parse(config.JUPITER_SWAP_BASE_URL),
    ).origin;
    this.source =
      this.#origin === 'https://api.jup.ag' ? 'JUPITER_LIVE' : 'LOOPBACK_TEST';
    this.reader = new HttpReader(
      {
        ...config,
        RISK_HTTP_TIMEOUT_MS: config.JUPITER_QUOTE_TIMEOUT_MS,
        RISK_HTTP_MAX_ATTEMPTS: 2,
      },
      config.JUPITER_SWAP_REQUEST_INTERVAL_MS,
      fetcher,
      undefined,
      now,
    );
  }

  async order(
    input: SwapRequest,
    mode: 'quote' | 'prepare' = 'quote',
  ): Promise<QuoteResult> {
    const request = swapRequestSchema.safeParse(input);
    if (!request.success)
      return { status: 'REJECTED', reason: 'INVALID_SWAP_REQUEST' };
    if (!this.config.JUPITER_SWAP_ENABLED)
      return { status: 'UNSUPPORTED', reason: 'JUPITER_SWAP_DISABLED' };
    if ((request.data.slippageBps ?? 0) > this.config.JUPITER_MAX_SLIPPAGE_BPS)
      return { status: 'REJECTED', reason: 'REQUEST_SLIPPAGE_EXCEEDS_POLICY' };
    const taker =
      mode === 'prepare' ? this.config.JUPITER_TAKER_PUBLIC_KEY : '';
    if (
      mode === 'prepare' &&
      (!this.config.JUPITER_UNSIGNED_BUILD_ENABLED || !taker)
    )
      return {
        status: 'UNSUPPORTED',
        reason: 'UNSIGNED_BUILD_DISABLED_OR_TAKER_MISSING',
      };
    const key = stableId(['jupiter-order-v2', request.data, taker]);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (this.inFlight.size >= 64)
      return { status: 'INSUFFICIENT_DATA', reason: 'CLIENT_BUSY' };
    const result = this.#request(request.data, taker).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, result);
    return result;
  }

  async #request(request: SwapRequest, taker: string): Promise<QuoteResult> {
    const started = this.now();
    const apiKey = this.config.JUPITER_API_KEY;
    const providerId = (value: string | null | undefined) =>
      value && (!apiKey || !value.includes(apiKey)) ? value : null;
    const url = new URL('/swap/v2/order', this.#origin);
    url.search = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount,
      swapMode: 'ExactIn',
      maxSupportedTransactionVersion: '0',
    }).toString();
    if (request.slippageBps !== undefined)
      url.searchParams.set('slippageBps', String(request.slippageBps));
    if (request.excludeRouters.length)
      url.searchParams.set('excludeRouters', request.excludeRouters.join(','));
    if (taker) url.searchParams.set('taker', taker);
    let response;
    try {
      response = await this.reader.request(
        url.href,
        {
          method: 'GET',
          headers:
            apiKey && this.source === 'JUPITER_LIVE'
              ? { 'x-api-key': apiKey }
              : {},
        },
        AbortSignal.timeout(this.config.JUPITER_QUOTE_TIMEOUT_MS * 2 + 4000),
        400,
      );
    } catch (error) {
      const details = providerError(error);
      return {
        status: 'INSUFFICIENT_DATA',
        reason: details.code,
        httpStatus: details.httpStatus,
        retryAt: details.retryAt,
        latencyMs: Math.max(0, this.now() - started),
      };
    }
    const latencyMs = Math.max(0, this.now() - started);
    let data: unknown;
    try {
      data = parse(response.body);
    } catch {
      return {
        status: 'INSUFFICIENT_DATA',
        reason: 'MALFORMED_JSON',
        latencyMs,
      };
    }
    const envelope = errorEnvelope.safeParse(data);
    if (
      response.httpStatus === 400 ||
      (envelope.success &&
        (envelope.data.routePlan?.length === 0 ||
          envelope.data.outAmount === '0' ||
          (envelope.data.error && envelope.data.outAmount === undefined)))
    ) {
      const details = envelope.success ? envelope.data : null;
      const noRoute =
        details?.routePlan?.length === 0 ||
        details?.outAmount === '0' ||
        (!!details?.error &&
          /no route|could not find.*route|token.*not tradable|route.*not found/i.test(
            details.error,
          ));
      return {
        status: noRoute ? 'UNSUPPORTED' : 'REJECTED',
        reason: noRoute ? 'NO_ROUTE' : 'PROVIDER_REJECTED',
        httpStatus: response.httpStatus,
        providerRequestId: providerId(details?.requestId),
        latencyMs,
      };
    }
    if (
      envelope.success &&
      envelope.data.router &&
      !routerSchema.safeParse(envelope.data.router).success
    )
      return { status: 'UNSUPPORTED', reason: 'UNKNOWN_ROUTER', latencyMs };
    const parsed = responseSchema.safeParse(data);
    if (!parsed.success)
      return {
        status: 'INSUFFICIENT_DATA',
        reason: 'INVALID_PROVIDER_RESPONSE',
        latencyMs,
      };
    const quote = parsed.data;
    if (
      quote.inputMint !== request.inputMint ||
      quote.outputMint !== request.outputMint ||
      quote.inAmount !== request.amount ||
      (quote.taker ?? '') !== taker ||
      (!taker && !!quote.transaction) ||
      (!!quote.transaction && quote.errorCode != null)
    )
      return {
        status: 'REJECTED',
        reason: 'ORDER_REQUEST_MISMATCH',
        latencyMs,
      };
    if (!routeConnects(quote) || request.excludeRouters.includes(quote.router))
      return { status: 'UNSUPPORTED', reason: 'UNSUPPORTED_ROUTE', latencyMs };
    const { transaction, quoteId, ...metadata } = quote;
    if (metadata.requestId != null)
      metadata.requestId = providerId(metadata.requestId);
    return {
      status: 'QUOTED',
      unsignedTransaction: taker ? transaction || null : null,
      quote: {
        ...metadata,
        id: stableId(['jupiter-quote-v2', metadata, response.receivedAt]),
        providerQuoteId: providerId(quoteId),
        provider: 'JUPITER',
        apiVersion: 'v2',
        quotedAt: response.receivedAt,
        requestedAt: new Date(started).toISOString(),
        applicationValidUntil: new Date(
          started + this.config.JUPITER_MAX_QUOTE_AGE_MS,
        ).toISOString(),
        inputAmount: fromBaseUnits(quote.inAmount, request.inputDecimals),
        expectedOutputAmount: fromBaseUnits(
          quote.outAmount,
          request.outputDecimals,
        ),
        latencyMs,
        source: this.source,
        routeAvailable: true,
        transactionStatus: taker
          ? transaction
            ? 'AVAILABLE'
            : 'BUILD_UNAVAILABLE'
          : 'QUOTE_ONLY',
        effectiveOutputPerInput: effectiveRate(request, quote.outAmount),
      },
    };
  }
}
