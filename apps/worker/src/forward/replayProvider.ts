import {
  compareHistoricalEvents,
  historicalFileSchema,
  stableHash,
} from '@solemn/shared';
import type { HistoricalEvent } from '@solemn/shared';
import { createStressFixture } from '../backtesting/stressScenarios.js';
import type { Config } from '../config/index.js';

export interface ReplayGap {
  start: string;
  end: string;
  reason: string;
}
export interface ForwardFrame {
  at: string;
  events: readonly HistoricalEvent[];
  gap: ReplayGap | null;
  connected: boolean;
  candleEnd: string | null;
  snapshot: boolean;
  final: boolean;
}
const iso = (time: number) => new Date(time).toISOString();

/** One bounded, deterministic tape. A gap removes evidence, including overlapping coverage claims. */
export function createReplayProvider(
  config: Config,
  input?: unknown,
  gaps?: readonly ReplayGap[],
) {
  const file =
    input === undefined
      ? createForwardReplayFixture(config)
      : historicalFileSchema.parse(input);
  if (file.manifest.sourceKind !== 'SYNTHETIC')
    throw new Error('Forward replay requires explicitly synthetic data');
  if (file.events.length > 20000 || file.manifest.markets.length > 100)
    throw new Error('Forward replay tape exceeds capacity');
  const { markets } = file.manifest;
  const start = Date.parse(file.manifest.startTime),
    end = Date.parse(file.manifest.endTime);
  const startTime = iso(start),
    endTime = iso(end);
  const cadenceMs = config.FORWARD_EQUITY_SNAPSHOT_INTERVAL_SECONDS * 1000;
  if (
    Math.ceil((end - start) / cadenceMs) > 30000 ||
    (end - start) / 60000 > 30000
  )
    throw new Error('Forward replay timer capacity exceeded');
  const outages =
    gaps ??
    (input === undefined
      ? [
          {
            start: iso(start + 16 * 60000 + 10000),
            end: iso(start + 17 * 60000 + 15000),
            reason: 'FIXTURE_DISCONNECT',
          },
        ]
      : []);
  let previous: number | undefined;
  for (const gap of outages) {
    const from = Date.parse(gap.start),
      to = Date.parse(gap.end);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < start ||
      (previous !== undefined && from <= previous) ||
      from >= to ||
      to > end
    )
      throw new Error('Invalid forward replay gap');
    previous = to;
  }
  const intervals = outages.map((g) => ({
    ...g,
    start: iso(Date.parse(g.start)),
    end: iso(Date.parse(g.end)),
  }));
  const scopes = new Set(markets.map((m) => `${m.mint}:${m.poolAddress}`));
  const byTime = new Map<string, HistoricalEvent[]>(),
    seen = new Map<string, string>();
  for (const event of [...file.events].sort(compareHistoricalEvents)) {
    const at = iso(Date.parse(event.availableAt));
    if (
      !scopes.has(`${event.mint}:${event.poolAddress}`) ||
      at < startTime ||
      at > endTime
    )
      throw new Error('Forward event outside tape scope');
    const hash = stableHash(event),
      existing = seen.get(event.id);
    if (existing && existing !== hash)
      throw new Error('Conflicting forward replay event');
    if (existing) continue;
    seen.set(event.id, hash);
    if (
      intervals.some(
        (g) =>
          (at >= g.start && at < g.end) ||
          (event.kind === 'COVERAGE' &&
            Date.parse(event.data.start) < Date.parse(g.end) &&
            Date.parse(event.data.end) > Date.parse(g.start)),
      )
    )
      continue;
    const list = byTime.get(at) ?? [];
    if (list.length >= 1000)
      throw new Error('Forward same-time event capacity exceeded');
    list.push(event);
    byTime.set(at, list);
  }
  const finalizations = new Map<string, string>();
  for (
    let t = start + 60000;
    t + config.MARKET_DATA_ALLOWED_LATENESS_MS <= end;
    t += 60000
  )
    finalizations.set(iso(t + config.MARKET_DATA_ALLOWED_LATENESS_MS), iso(t));
  const cadence = new Set<string>();
  for (let t = start; t < end; t += cadenceMs) cadence.add(iso(t));
  const times = [
    ...new Set([
      startTime,
      endTime,
      ...byTime.keys(),
      ...finalizations.keys(),
      ...cadence,
      ...intervals.flatMap((g) => [g.start, g.end]),
    ]),
  ].sort();
  if (times.length > 30000)
    throw new Error('Forward replay frame capacity exceeded');
  return {
    mode: 'REPLAY' as const,
    startTime,
    endTime,
    markets,
    fingerprint: stableHash([file, outages]),
    async *frames(): AsyncIterable<ForwardFrame> {
      for (const at of times)
        yield {
          at,
          events: byTime.get(at) ?? [],
          gap: intervals.find((g) => g.start === at || g.end === at) ?? null,
          connected: !intervals.some((g) => at >= g.start && at < g.end),
          candleEnd: finalizations.get(at) ?? null,
          snapshot: cadence.has(at) || at === endTime,
          final: at === endTime,
        };
    },
  };
}
export type ReplayProvider = ReturnType<typeof createReplayProvider>;

export function createForwardReplayFixture(config: Config) {
  const file = createStressFixture(config),
    market = file.manifest.markets[0]!;
  return {
    ...file,
    manifest: { ...file.manifest, markets: [market] },
    events: file.events
      .filter((event) => event.mint === market.mint)
      .map((event) => {
        if (event.kind !== 'EXECUTION' || !event.data.pool) return event;
        return {
          ...event,
          data: {
            ...event.data,
            pool: { ...event.data.pool, transfers: 'ENABLED' as const },
          },
        };
      }),
  };
}
