import { parse } from 'lossless-json';
import { z } from 'zod';
import {
  jupiterObservationSchema,
  mintAddressSchema,
  percentageSchema,
  timestampSchema,
} from '@solemn/shared';
import type { JupiterObservation } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { HttpReader, ProviderError, providerError } from './httpReader.js';
import { emptyJupiter, providerDecimal } from './observations.js';

const auditSchema = z.looseObject({
  mintAuthorityDisabled: z.boolean().nullish(),
  freezeAuthorityDisabled: z.boolean().nullish(),
  topHoldersPercentage: z.unknown().optional(),
  isSus: z.boolean().nullish(),
});
const tokenResponse = z.looseObject({
  id: mintAddressSchema,
  name: z.string().max(1024).nullish(),
  symbol: z.string().max(256).nullish(),
  decimals: z
    .string()
    .regex(/^\d{1,3}$/)
    .refine((value) => Number(value) <= 255)
    .nullish(),
  tokenProgram: mintAddressSchema.nullish(),
  updatedAt: timestampSchema.nullish(),
  audit: auditSchema.nullish(),
  isSus: z.boolean().nullish(),
  isVerified: z.boolean().nullish(),
  mintAuthority: mintAddressSchema.nullish(),
  freezeAuthority: mintAddressSchema.nullish(),
});

export interface JupiterClient {
  getMany(
    mints: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, JupiterObservation>>;
  invalidate(mint: string): void;
}

export class JupiterTokenClient implements JupiterClient {
  private readonly reader: HttpReader;
  private readonly cache = new Map<
    string,
    { observation: JupiterObservation; expires: number }
  >();
  private readonly inFlight = new Map<string, Promise<JupiterObservation>>();
  constructor(
    private readonly config: Config,
    fetcher: typeof fetch = fetch,
    onRateLimit: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.reader = new HttpReader(
      config,
      config.JUPITER_REQUEST_INTERVAL_MS,
      fetcher,
      onRateLimit,
      now,
    );
  }
  invalidate(mint: string): void {
    this.cache.delete(mint);
  }

  async getMany(
    mints: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, JupiterObservation>> {
    const unique = [
      ...new Set(mints.map((mint) => mintAddressSchema.parse(mint))),
    ];
    if (unique.length > 1000)
      throw new Error('Jupiter batch admission exceeds 1000 mints');
    const results = new Map<string, Promise<JupiterObservation>>();
    const needed: string[] = [];
    for (const mint of unique) {
      const cached = this.cache.get(mint);
      if (cached && cached.expires > this.now())
        results.set(mint, Promise.resolve(structuredClone(cached.observation)));
      else if (this.inFlight.has(mint))
        results.set(
          mint,
          this.inFlight.get(mint) as Promise<JupiterObservation>,
        );
      else needed.push(mint);
    }
    if (this.inFlight.size + needed.length > 1000) {
      for (const mint of needed)
        results.set(
          mint,
          Promise.resolve({
            ...emptyJupiter(mint, new Date(this.now()).toISOString()),
            state: 'ERROR',
            error: { code: 'CLIENT_BUSY', httpStatus: null, retryAt: null },
          }),
        );
    } else {
      for (let offset = 0; offset < needed.length; offset += 100) {
        const batch = needed.slice(offset, offset + 100);
        const fetching = this.fetchBatch(batch, signal);
        for (const mint of batch) {
          const pending = fetching
            .then(
              (observations) => observations.get(mint) as JupiterObservation,
            )
            .then((observation) => {
              if (
                observation.state === 'OK' &&
                this.config.JUPITER_CACHE_TTL_MS > 0
              ) {
                this.cache.delete(mint);
                this.cache.set(mint, {
                  observation: structuredClone(observation),
                  expires: this.now() + this.config.JUPITER_CACHE_TTL_MS,
                });
                while (
                  this.cache.size > this.config.JUPITER_CACHE_MAX_ENTRIES
                ) {
                  const oldest = this.cache.keys().next().value;
                  if (oldest !== undefined) this.cache.delete(oldest);
                  else break;
                }
              }
              return observation;
            })
            .finally(() => {
              if (this.inFlight.get(mint) === pending)
                this.inFlight.delete(mint);
            });
          this.inFlight.set(mint, pending);
          results.set(mint, pending);
        }
      }
    }
    return new Map(
      await Promise.all(
        [...results].map(
          async ([mint, observation]) =>
            [mint, structuredClone(await observation)] as const,
        ),
      ),
    );
  }

  private async fetchBatch(
    mints: string[],
    signal: AbortSignal,
  ): Promise<Map<string, JupiterObservation>> {
    const fetchedAt = () => new Date(this.now()).toISOString();
    try {
      const url = new URL(
        `${this.config.JUPITER_TOKENS_BASE_URL.replace(/\/$/, '')}/search`,
      );
      url.searchParams.set('query', mints.join(','));
      const response = await this.reader.request(
        url.toString(),
        {
          method: 'GET',
          headers: this.config.JUPITER_API_KEY
            ? { 'x-api-key': this.config.JUPITER_API_KEY }
            : {},
        },
        signal,
      );
      let parsed: unknown;
      try {
        parsed = parse(response.body, undefined, (value) => value);
      } catch {
        throw new ProviderError({
          code: 'INVALID_RESPONSE',
          httpStatus: 200,
          retryAt: null,
        });
      }
      const rows = z.array(tokenResponse).max(100).safeParse(parsed);
      if (!rows.success)
        throw new ProviderError({
          code: 'INVALID_RESPONSE',
          httpStatus: 200,
          retryAt: null,
        });
      if (
        rows.data.some((row) => !mints.includes(row.id)) ||
        new Set(rows.data.map((row) => row.id)).size !== rows.data.length
      )
        throw new ProviderError({
          code: 'MINT_MISMATCH',
          httpStatus: 200,
          retryAt: null,
        });
      return new Map(
        mints.map((mint) => {
          const data = rows.data.find((row) => row.id === mint);
          if (!data)
            return [
              mint,
              {
                ...emptyJupiter(mint, response.receivedAt),
                rawResponse: response.body,
              },
            ];
          const issues: string[] = [];
          const amount = (
            value: unknown,
            field: string,
            percentage = false,
          ) => {
            if (value === undefined || value === null) return null;
            const exact = providerDecimal(value);
            if (
              exact === null ||
              (percentage && !percentageSchema.safeParse(exact).success)
            ) {
              issues.push(`INVALID_${field}`);
              return null;
            }
            return exact;
          };
          if (
            (data.mintAuthority &&
              data.audit?.mintAuthorityDisabled === true) ||
            (data.freezeAuthority &&
              data.audit?.freezeAuthorityDisabled === true)
          )
            issues.push('AUTHORITY_AUDIT_CONFLICT');
          if (
            typeof data.isSus === 'boolean' &&
            typeof data.audit?.isSus === 'boolean' &&
            data.isSus !== data.audit.isSus
          )
            issues.push('SUSPICIOUS_FLAG_CONFLICT');
          let holderCount: string | null = null;
          if (data.holderCount != null) {
            if (
              typeof data.holderCount === 'string' &&
              /^\d{1,30}$/.test(data.holderCount)
            )
              holderCount = data.holderCount;
            else issues.push('INVALID_HOLDER_COUNT');
          }
          const observation = jupiterObservationSchema.parse({
            ...emptyJupiter(mint, response.receivedAt),
            state: 'OK',
            updatedAt: data.updatedAt ?? null,
            name: data.name ?? null,
            symbol: data.symbol ?? null,
            decimals: data.decimals == null ? null : Number(data.decimals),
            tokenProgram: data.tokenProgram ?? null,
            usdPrice: amount(data.usdPrice, 'PRICE'),
            liquidityUsd: amount(data.liquidity, 'LIQUIDITY'),
            marketCapUsd: amount(data.mcap, 'MARKET_CAP'),
            activity: Object.keys(data).some((key) =>
              /^stats(?:5m|1h|6h|24h)$/.test(key),
            )
              ? z
                  .record(z.string(), z.json())
                  .parse(
                    Object.fromEntries(
                      Object.entries(data).filter(([key]) =>
                        /^stats(?:5m|1h|6h|24h)$/.test(key),
                      ),
                    ),
                  )
              : null,
            holderCount,
            organicScore: amount(data.organicScore, 'ORGANIC_SCORE', true),
            isVerified: data.isVerified ?? null,
            mintAuthorityDisabled: data.audit?.mintAuthorityDisabled ?? null,
            freezeAuthorityDisabled:
              data.audit?.freezeAuthorityDisabled ?? null,
            topHoldersPercentage: amount(
              data.audit?.topHoldersPercentage,
              'HOLDER_CONCENTRATION',
              true,
            ),
            isSus:
              data.isSus === true || data.audit?.isSus === true
                ? true
                : (data.audit?.isSus ?? data.isSus ?? null),
            issues,
            rawResponse: response.body,
          });
          return [mint, observation];
        }),
      );
    } catch (error) {
      return new Map(
        mints.map((mint) => [
          mint,
          {
            ...emptyJupiter(mint, fetchedAt()),
            state: 'ERROR',
            error: providerError(error),
          },
        ]),
      );
    }
  }
}
