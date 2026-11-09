import {
  compareHistoricalEvents,
  historicalFileSchema,
  stableHash,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type {
  ExecutionObservation,
  HistoricalEvent,
  PoolSnapshot,
} from '@solemn/shared';
import type { Config } from '../config/index.js';
import { createBacktestFixture } from './replayFixture.js';
/** Explicit fictional reserves, not a conversion of aggregate reported liquidity. Same tape for every scenario. */
export function createStressFixture(config: Config) {
  const base = createBacktestFixture(config);
  const events: HistoricalEvent[] = base.events.filter(
    (e) => e.kind !== 'EXECUTION',
  );
  const start = Date.parse(base.manifest.startTime),
    at = (ms: number) => new Date(start + ms).toISOString();
  for (const [index, market] of base.manifest.markets.slice(0, 3).entries()) {
    for (let ms = 14 * 60000 + 4000; ms < 20 * 60000; ms += 1000) {
      const t = ms + index * 20;
      let price = '124';
      if (index === 0)
        price =
          ms >= 19 * 60000
            ? '270'
            : ms >= 18 * 60000
              ? '400'
              : ms >= 17 * 60000
                ? '350'
                : ms >= 16 * 60000
                  ? '210'
                  : '124';
      if (index === 1 && ms >= 15 * 60000)
        price = ms < 15 * 60000 + 1000 ? '90' : '8';
      if (index === 2)
        price =
          ms >= 17 * 60000
            ? '50'
            : ms >= 16 * 60000
              ? '8'
              : ms >= 15 * 60000
                ? '150'
                : '124';
      const gone = index === 2 && ms >= 16 * 60000 && ms < 17 * 60000;
      const frozen = index === 0 && ms >= 19 * 60000;
      // 100 tokens and explicit quote units give shallow, measurable curve depth.
      const baseReserve = gone ? '0' : '100000000000',
        quoteReserve = gone
          ? '0'
          : ((100n * toAtomic(price)) / 1000000000000n).toString();
      for (const [side, offset] of [
        ['BUY', 0],
        ['SELL', 10],
      ] as const) {
        const observedAt = at(t + offset),
          id = stableId(['stress-observation-v1', market.mint, t, side]);
        const pool: PoolSnapshot = {
          id: stableId(['stress-pool-v1', market.mint, t, side]),
          poolAddress: market.poolAddress,
          baseMint: market.mint,
          quoteMint: market.quoteMint,
          model: 'REFERENCE_CPMM_V1',
          baseDecimals: 9,
          quoteDecimals: 6,
          baseReserve,
          quoteReserve,
          quoteUsd: '1',
          observedAt,
          availableAt: observedAt,
          source: 'SOLEMN_WEEK7_EXPLICIT_SYNTHETIC_RESERVES',
          quality: 'SYNTHETIC',
          transfers: frozen ? 'FROZEN' : 'ENABLED',
          fees: {
            source:
              'REFERENCE_CPMM_V1 synthetic input-asset fees; not PumpSwap',
            kind: 'RESEARCH',
            validFrom: base.manifest.startTime,
            validUntil: at(21 * 60000),
            lpBps: 25,
            protocolBps: 5,
            creatorBps: 0,
            routingBps: 0,
            integratorBps: 0,
          },
          baseTransferFee: null,
          quoteTransferFee: null,
          networkHint: 'NORMAL',
        };
        const observation: ExecutionObservation = {
          id,
          mint: market.mint,
          poolAddress: market.poolAddress,
          side,
          observedAt,
          receivedAt: observedAt,
          priceUsd: price,
          liquidityUsd: gone ? '0' : '50000',
          estimatedPriceImpactPercent: null,
          usdReliable: true,
          healthy: true,
          usdSource: 'FICTIONAL_USD_QUOTE',
          source: pool.source,
          sourceTradeId: null,
          dataMode: 'FIXTURE',
          simulationOutcome: 'FULL_FILL',
          pool,
          nativeUsd: {
            priceUsd: '150',
            observedAt,
            availableAt: observedAt,
            source: 'FICTIONAL_HISTORICAL_SOL_USD',
          },
        };
        events.push({
          id,
          mint: market.mint,
          poolAddress: market.poolAddress,
          kind: 'EXECUTION',
          eventAt: observedAt,
          availableAt: observedAt,
          source: pool.source,
          slot: String(100000 + t),
          transactionIndex: offset,
          providerIndex: index,
          data: observation,
        } as HistoricalEvent);
      }
    }
  }
  return historicalFileSchema.parse({
    manifest: {
      ...base.manifest,
      datasetId: 'solemn-week7-execution-stress',
      version: `1.0.0-${stableHash(base.manifest).slice(0, 12)}`,
      name: 'Week 7 explicit-reserve synthetic stress tape',
      provenance:
        'Synthetic reference CPMM: shallow reserves, >90% collapse after stop quote, liquidity disappears then returns, frozen transfers. Not observed market performance.',
    },
    events: events.sort(compareHistoricalEvents),
  });
}
