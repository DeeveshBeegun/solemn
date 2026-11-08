import { describe, expect, it } from 'vitest';
import {
  analyzeHistory,
  historicalEventSchema,
  historicalSortKey,
  compareHistoricalEvents,
  stableId,
} from '@solemn/shared';
import { SimulationClock } from '../src/backtesting/clock.js';
import { createBacktestFixture } from '../src/backtesting/replayFixture.js';
import {
  historyEvents,
  validateHistoricalFile,
  FixtureHistoricalDataProvider,
} from '../src/backtesting/historicalDataProvider.js';
import {
  createBacktestPlan,
  parseBacktestOptions,
} from '../src/backtesting/backtestConfig.js';
import { backtestConfig, backtestSetup } from './backtestFixtures.js';
import { parseBacktestArguments } from '../src/backtesting/cli.js';
import { csvCell } from '../src/backtesting/reportGenerator.js';
import { replayTime } from '../src/strategy/replayFixture.js';
describe('validated historical datasets', () => {
  it('orders by availability, records gaps/missing inputs and deduplicates exact source events', async () => {
    const file = createBacktestFixture(backtestConfig),
      event = file.events.find((item) => item.kind === 'TRADE')!;
    const duplicated = [...file.events, structuredClone(event)].sort(
      compareHistoricalEvents,
    );
    const report = await analyzeHistory(
      file.manifest,
      historyEvents(duplicated),
    );
    expect(report.quality.duplicateEvents).toBe(1);
    expect(report.quality.totalTokens).toBe(6);
    expect(report.quality.marketDataGaps).toBe(1);
    expect(report.quality.missingPriceObservations).toBeGreaterThan(0);
    const original = await analyzeHistory(
      file.manifest,
      historyEvents(file.events),
    );
    expect(report.fingerprint).toBe(original.fingerprint);
    const unordered = [...file.events].reverse();
    expect(
      validateHistoricalFile({ ...file, events: unordered }).events,
    ).toEqual(file.events);
    await expect(
      analyzeHistory(file.manifest, historyEvents(unordered)),
    ).rejects.toThrow('canonically ordered');
  });
  it('rejects mismatched pools, unknown formats and impossible temporal availability', async () => {
    const file = createBacktestFixture(backtestConfig, 'winner'),
      event = structuredClone(
        file.events.find((item) => item.kind === 'TRADE')!,
      );
    expect(() =>
      historicalEventSchema.parse({ ...event, availableAt: replayTime(0) }),
    ).toThrow();
    expect(() =>
      historicalEventSchema.parse({ ...event, kind: 'SOME_NEW_EVENT' }),
    ).toThrow();
    expect(() =>
      historicalEventSchema.parse({
        ...event,
        availableAt: '2026-01-01T00:00:04.000001Z',
      }),
    ).toThrow('milliseconds');
    await expect(
      analyzeHistory({ ...file.manifest, markets: [] }, historyEvents([event])),
    ).rejects.toThrow('unsupported pool');
  });
  it('classifies an empty dataset as insufficient and records unknown source/timestamp observations', async () => {
    const file = createBacktestFixture(backtestConfig, 'winner');
    expect(
      (await analyzeHistory(file.manifest, historyEvents([]))).quality
        .readiness,
    ).toBe('INSUFFICIENT');
    const event = {
      ...file.events[0]!,
      id: stableId(['unknown-source']),
      kind: 'UNKNOWN' as const,
      eventAt: null,
      data: { unrecognized: true },
    };
    const report = await analyzeHistory(file.manifest, historyEvents([event]));
    expect(report.quality.unknownSourceEvents).toBe(1);
    expect(report.quality.missingTimestamps).toBe(1);
  });
  it('filters date ranges without substituting other observations', async () => {
    const setup = await backtestSetup('winner'),
      provider = new FixtureHistoricalDataProvider(setup.dataset, setup.file),
      events = [];
    for await (const event of provider.getEvents({
      startTime: replayTime(10),
      endTime: replayTime(11),
      batchSize: 2,
    }))
      events.push(event);
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event) =>
          event.availableAt >= replayTime(10) &&
          event.availableAt <= replayTime(11),
      ),
    ).toBe(true);
  });
  it('uses stable technical ordering for slots while retaining ambiguity in unsequenced same-time prices', async () => {
    const file = createBacktestFixture(backtestConfig, 'winner'),
      original = file.events.find((item) => item.kind === 'EXECUTION')!;
    if (original.kind !== 'EXECUTION') throw new Error('Missing quote');
    const a = {
        ...original,
        id: stableId(['slot-a']),
        slot: '2',
        transactionIndex: 1,
      },
      b = {
        ...original,
        id: stableId(['slot-b']),
        slot: '10',
        transactionIndex: 0,
      };
    expect(historicalSortKey(a) < historicalSortKey(b)).toBe(true);
    const conflict = {
      ...original,
      id: stableId(['unsequenced-price']),
      data: { ...original.data, priceUsd: '999' },
    };
    const report = await analyzeHistory(
      file.manifest,
      historyEvents([original, conflict].sort(compareHistoricalEvents)),
    );
    expect(report.quality.uncertainOrderingGroups).toBe(1);
  });
});
describe('simulation clock and configuration', () => {
  it('advances historical time without wall-clock waits and rejects regressions', () => {
    const clock = new SimulationClock(replayTime(0));
    clock.advance(replayTime(60));
    expect(clock.now().toISOString()).toBe(replayTime(60));
    expect(() => clock.advance(replayTime(59))).toThrow('backwards');
  });
  it('validates run ranges, costs, balances, latency and PAPER-only mode', async () => {
    const setup = await backtestSetup('winner');
    expect(() =>
      createBacktestPlan(
        { dataset: 'fixtures', startTime: replayTime(-1) },
        setup.dataset,
        backtestConfig,
      ),
    ).toThrow('does not exist');
    expect(() =>
      createBacktestPlan(
        {
          dataset: 'fixtures',
          startTime: replayTime(10),
          endTime: replayTime(5),
        },
        setup.dataset,
        backtestConfig,
      ),
    ).toThrow();
    expect(() =>
      createBacktestPlan(
        { dataset: 'fixtures', initialBalanceUsd: '0' },
        setup.dataset,
        backtestConfig,
      ),
    ).toThrow();
    for (const input of [
      { dataset: '' },
      { dataset: 'fixtures', executionLatencyMs: -1 },
      { dataset: 'fixtures', tradingMode: 'LIVE' },
      { dataset: 'fixtures', batchSize: 1001 },
    ])
      expect(() => parseBacktestOptions(input)).toThrow();
  });
  it('parses CLI aliases and protects CSV delimiters and formula-like labels', async () => {
    const options = await parseBacktestArguments([
      '--dataset',
      'fixtures',
      '--start',
      '2026-01-01',
      '--initial-balance',
      '100',
      '--latency-ms',
      '2000',
      '--verbose',
    ]);
    expect(options).toMatchObject({
      startTime: replayTime(0),
      executionLatencyMs: 2000,
      verbose: true,
    });
    await expect(
      parseBacktestArguments(['--dataset', 'fixtures', '--latency-ms', '1.5']),
    ).rejects.toThrow('integers');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('-1.25')).toBe('-1.25');
    expect(csvCell('=HYPERLINK("x")')).toContain("'=HYPERLINK");
    expect(csvCell(null)).toBe('');
  });
});
