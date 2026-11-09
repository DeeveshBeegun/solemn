import { getAddressDecoder } from '@solana/kit';
import {
  compareHistoricalEvents,
  fromAtomic,
  historicalFileSchema,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type { HistoricalEvent, HistoricalMarket } from '@solemn/shared';
import type { Config } from '../config/index.js';
import { createStressFixture } from './stressScenarios.js';

/** A fixed synthetic tape with consecutive losses, fee-paying failures and an unresolved holding. */
export function createAnalyticsFixture(config: Config) {
  const base = createStressFixture(config),
    markets: HistoricalMarket[] = [],
    events: HistoricalEvent[] = [];
  const scenarios = [
    'WIN',
    'WIN',
    'LOSS',
    'LOSS',
    'LOSS',
    'OUTLIER',
    'FAILED_ENTRY',
    'BLOCKED_EXIT',
  ] as const;
  const blockMs = 20 * 60000;
  const start = Date.parse(base.manifest.startTime);
  const address = (byte: number) =>
    getAddressDecoder().decode(new Uint8Array(32).fill(byte));
  for (const [index, scenario] of scenarios.entries()) {
    const original = base.manifest.markets[scenario === 'LOSS' ? 1 : 0]!;
    const shift = index * blockMs,
      mint = address(190 + index),
      poolAddress = address(220 + index);
    const time = (t: string) => new Date(Date.parse(t) + shift).toISOString();
    const replace = (value: unknown): unknown => {
      if (typeof value === 'string') {
        if (value === original.mint) return mint;
        if (value === original.poolAddress) return poolAddress;
        if (/^2026-01-01T\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
          return time(value);
        if (
          /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(
            value,
          )
        )
          return stableId(['analytics-fixture-ref-v1', index, value]);
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => [key, replace(v)]),
        );
      return value;
    };
    markets.push(replace(original) as HistoricalMarket);
    for (const source of base.events) {
      if (
        source.mint !== original.mint ||
        source.poolAddress !== original.poolAddress
      )
        continue;
      const event = replace(source) as HistoricalEvent;
      const minute = Math.floor(
        (Date.parse(source.eventAt ?? source.availableAt) - start) / 60000,
      );
      if (event.kind === 'TRADE') {
        if (scenario === 'BLOCKED_EXIT' && minute === 18) continue;
        event.data.sourceEventId = `analytics-${index}:${event.data.sourceEventId}`;
        event.data.id = stableId([
          'market-trade',
          event.data.source,
          event.data.sourceEventId,
        ]);
      }
      if (
        event.kind === 'COVERAGE' &&
        scenario === 'BLOCKED_EXIT' &&
        Date.parse(event.data.start) === start + shift + 18 * 60000
      ) {
        event.data.kind = 'GAP';
        event.data.reason = 'ANALYTICS_FIXTURE_MISSING_TRADE_INTERVAL';
      }
      if (event.kind === 'EXECUTION' && event.data.pool) {
        const pool = event.data.pool;
        if (scenario !== 'BLOCKED_EXIT') pool.transfers = 'ENABLED';
        if (scenario === 'FAILED_ENTRY' && event.data.side === 'BUY')
          pool.networkHint = 'FAILED_ON_CHAIN';
        if (scenario === 'OUTLIER' && minute >= 16 && event.data.priceUsd) {
          event.data.priceUsd = fromAtomic(toAtomic(event.data.priceUsd) * 5n);
          pool.quoteReserve = (BigInt(pool.quoteReserve) * 5n).toString();
        }
      }
      events.push(event);
    }
  }
  return historicalFileSchema.parse({
    manifest: {
      ...base.manifest,
      datasetId: 'solemn-week9-analytics',
      name: 'Week 9 synthetic profitability sensitivity tape',
      version: `1.0.0-${base.manifest.version}`,
      provenance:
        'SYNTHETIC deterministic validation of accounting, failed attempts, unresolved exits, missing trades and concentration. All market states are invented.',
      endTime: new Date(start + scenarios.length * blockMs).toISOString(),
      markets,
    },
    events: events.sort(compareHistoricalEvents),
  });
}
