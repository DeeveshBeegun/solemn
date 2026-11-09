import { beforeAll, describe, expect, it } from 'vitest';
import { stableId, toAtomic } from '@solemn/shared';
import type { PaperPosition } from '@solemn/shared';
import { closedPositionMetrics } from '../src/analytics/closedPositionMetrics.js';
import { analyzeDrawdown } from '../src/analytics/drawdown.js';
import { analyzeCosts } from '../src/analytics/executionCostAnalyzer.js';
import { statisticalValidation } from '../src/analytics/statisticalValidation.js';
import { analyzeSignals } from '../src/analytics/signalAnalyzer.js';
import type { CapturedPortfolio } from '../src/analytics/contracts.js';
import { parseAnalyticsArguments } from '../src/analytics/cli.js';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import { replayStrategy } from '../src/strategy/replay.js';
import { replayTime } from '../src/strategy/replayFixture.js';
import { memoryStrategyRepository } from './strategyFixtures.js';
import { paperConfig, paperEntrySetup } from './paperFixtures.js';

let setup: Awaited<ReturnType<typeof paperEntrySetup>>, opened: PaperPosition;
beforeAll(async () => {
  setup = await paperEntrySetup();
  opened = applyPaperCommand(setup.state, setup.command, setup.definition).state
    .positions[0]!;
});
const closed = (net: string, basis = '1', i = 0): PaperPosition => ({
  ...opened,
  id: stableId(['analytics-metric', i, net, basis]),
  status: 'CLOSED',
  quantity: '0',
  costBasisUsd: '0',
  initialCostBasisUsd: basis,
  realizedPnlUsd: net,
  closedAt: replayTime(16 + i),
});

describe('exact closed-position metrics', () => {
  it('averages net P&L and per-position returns separately with breakevens and unequal sizes', () => {
    const result = closedPositionMetrics([
      closed('3', '2'),
      closed('-1', '1', 1),
      closed('0', '4', 2),
    ]);
    expect(result).toMatchObject({
      closedPositions: 3,
      winningClosedPositions: 1,
      losingClosedPositions: 1,
      breakEvenClosedPositions: 1,
      closedNetPnlUsd: '2',
      winRatePercent: '33.333333333333333333',
      expectancyUsd: '0.666666666666666666',
      meanReturnPercent: '16.666666666666666666',
      medianPositionReturnPercent: '0',
      averageWinningReturnPercent: '150',
      averageLosingReturnPercent: '-100',
      profitFactor: { value: '3' },
    });
  });
  it.each([
    { nets: [], factor: null, reason: 'NO_CLOSED_POSITIONS', expectancy: null },
    {
      nets: ['1'],
      factor: null,
      reason: 'NO_LOSING_CLOSED_POSITIONS',
      expectancy: '1',
    },
    { nets: ['-1', '-3'], factor: '0', reason: null, expectancy: '-2' },
    { nets: ['1', '-1'], factor: '1', reason: null, expectancy: '0' },
  ])(
    'handles loss-free, win-free and empty denominators %#',
    ({ nets, factor, reason, expectancy }) => {
      expect(
        closedPositionMetrics(nets.map((v, i) => closed(v, '1', i))),
      ).toMatchObject({
        profitFactor: { value: factor, reason },
        expectancyUsd: expectancy,
      });
    },
  );
  it('keeps an atomic-dollar loss and a large winner exact', () => {
    const result = closedPositionMetrics([
      closed('999999999999999999999999999999999999', '0.000000000000000001'),
      closed('-0.000000000000000001', '1', 1),
    ]);
    expect(result.closedNetPnlUsd).toBe(
      '999999999999999999999999999999999998.999999999999999999',
    );
    expect(result.largestLosingPositionUsd).toBe('-0.000000000000000001');
    expect(
      statisticalValidation(
        [
          closed(
            '999999999999999999999999999999999999',
            '0.000000000000000001',
          ),
          closed('-0.000000000000000001', '1', 1),
        ],
        replayTime(0),
        replayTime(20),
      ).withoutLargestWinner?.remainingClosedNetPnlUsd,
    ).toBe('-0.000000000000000001');
  });
  it('detects profit concentration and removes one or three winners deterministically', () => {
    const sample = ['12', '1', '2', '-4', '-3'].map((v, i) =>
      closed(v, '2', i),
    );
    const result = statisticalValidation(
      sample,
      replayTime(15),
      replayTime(22),
    );
    expect(result).toMatchObject({
      completedPositions: 5,
      topWinnerShareOfGrossWinsPercent: '80',
      topThreeShareOfGrossWinsPercent: '100',
      sampleLimited: true,
      withoutLargestWinner: {
        remainingClosedNetPnlUsd: '-4',
        signChanged: true,
      },
      withoutThreeLargestWinners: { remainingClosedNetPnlUsd: '-7' },
    });
    expect(
      result.chronological
        .map((p) => p.closedPositions)
        .reduce((a, b) => a + b, 0),
    ).toBe(5);
    expect(
      statisticalValidation(sample, replayTime(15), replayTime(22)),
    ).toEqual(result);
  });
});

describe('equity curve coverage', () => {
  const points = (values: (string | null)[]) =>
    values.map((equityUsd, i) => ({
      at: replayTime(i),
      equityUsd,
      reason: equityUsd === null ? 'UNKNOWN' : null,
    }));
  it('preserves earlier peak and peak-to-trough drawdown across a gap and recovery', () => {
    const result = analyzeDrawdown(
      points(['100', '140', null, '98', '160', '144']),
      { startTime: replayTime(0), equityCadenceMs: 60000 },
      replayTime(0),
      replayTime(5),
    );
    expect(result).toMatchObject({
      peakEquityUsd: '160',
      maximumObservedDrawdownUsd: '42',
      maximumObservedDrawdownPercent: '30',
      currentDrawdownPercent: '10',
      uncertainSnapshots: 1,
      missingScheduledSnapshots: 0,
      coverageComplete: false,
      uncertainIntervals: [{ from: replayTime(2), to: replayTime(3) }],
    });
  });
  it('detects a missed scheduled point and never carries forward terminal equity', () => {
    const values = points(['100', '110', '120', null]);
    values.splice(1, 1);
    expect(
      analyzeDrawdown(
        values,
        { startTime: replayTime(0), equityCadenceMs: 60000 },
        replayTime(0),
        replayTime(3),
      ),
    ).toMatchObject({
      currentDrawdownPercent: null,
      maximumObservedDrawdownPercent: '0',
      missingScheduledSnapshots: 1,
      largestSnapshotGapMs: 120000,
    });
  });
  it('does not invent drawdown when all marks are unknown', () => {
    expect(
      analyzeDrawdown(points([null, null]), null, replayTime(0), replayTime(1)),
    ).toMatchObject({
      maximumObservedDrawdownUsd: null,
      maximumObservedDrawdownPercent: null,
      peakEquityUsd: null,
      coverageComplete: false,
    });
  });
});

it('uses booked legacy charges and keeps missing network costs unknown', () => {
  const { orders } = applyPaperCommand(
    setup.state,
    setup.command,
    setup.definition,
  );
  expect(orders[0]?.order.status).toBe('FILLED');
  const costs = analyzeCosts(orders, toAtomic(opened.initialCostBasisUsd));
  expect(costs).toMatchObject({
    bookedFeesUsd: opened.feesUsd,
    legacyOrders: 1,
    complete: false,
    networkFeesUsd: null,
    priorityFeesUsd: null,
    quoteMovementUsd: null,
  });
});

it('deduplicates stable signals and distinguishes risk rejection, missing execution and unresolved positions', async () => {
  const replay = await replayStrategy(
    setup.fixture.marketDataset,
    paperConfig,
    memoryStrategyRepository().repository,
  );
  const template = replay.decisions.find((d) => d.candidate)!;
  const decisions = Array.from({ length: 4 }, (_, i) => ({
    ...template,
    id: stableId(['analytics-decision', i]),
    candidate: {
      ...template.candidate!,
      id: stableId(['analytics-candidate', i]),
    },
  }));
  const market = setup.fixture.marketDataset.markets.find(
    (m) => m.mint === template.mint,
  )!;
  const input: CapturedPortfolio = {
    source: 'paper-replay',
    sourceId: 'test',
    portfolioId: setup.definition.id,
    strategyId: setup.definition.strategyPolicy.strategyId,
    runId: null,
    definition: setup.definition,
    execution: null,
    configurationHash: setup.definition.configHash,
    start: replayTime(0),
    end: replayTime(20),
    availableStart: replayTime(0),
    availableEnd: replayTime(20),
    periodType: 'DEVELOPMENT',
    registration: null,
    startState: setup.state,
    endState: {
      ...setup.state,
      positions: [
        {
          ...opened,
          signalId: decisions[2]!.candidate.id,
          status: 'EXIT_BLOCKED',
        },
        { ...closed('1'), signalId: decisions[3]!.candidate.id },
      ],
    },
    journal: [],
    priorOrders: [],
    decisions: [...decisions, decisions[0]!],
    intents: [
      {
        signalId: decisions[0]!.candidate.id,
        at: replayTime(15),
        status: 'FAILED',
        reasons: ['PORTFOLIO_HALTED'],
        orderId: null,
      },
      {
        signalId: decisions[1]!.candidate.id,
        at: replayTime(15),
        status: 'EXPIRED',
        reasons: ['NO_VALID_EXECUTION_OBSERVATION'],
        orderId: null,
      },
    ],
    equity: [],
    markets: [
      {
        mint: market.mint,
        poolAddress: market.poolAddress,
        quoteMint: market.quoteMint,
        poolCreatedAt: market.poolCreatedAt,
        poolCreationAvailableAt: replayTime(19),
      },
    ],
    quality: null,
    observations: {
      discovered: [market.mint],
      analyzed: [market.mint],
      eligible: [market.mint],
      watched: null,
      marketGaps: null,
      downtimeMs: null,
      observationCount: null,
      rawTradeCount: null,
      missingPrice: null,
      missingLiquidity: null,
      missingRisk: null,
      duplicates: null,
      rejected: null,
      observedRuntimeMs: null,
    },
    cadence: null,
    sourceFingerprint: 'fixture',
    inputFingerprint: 'fixture',
  };
  const result = analyzeSignals(input);
  expect(result.rows.map((r) => r.outcome)).toEqual([
    'RISK_REJECTED',
    'NO_EXECUTION_OBSERVATION',
    'EXIT_BLOCKED',
    'CLOSED_WIN',
  ]);
  expect(result.funnel).toMatchObject({
    buyCandidates: 4,
    duplicates: 1,
    distinctSignalTokens: 1,
    eligibleToSignalTokenPercent: '100',
    closedPositions: 1,
  });
  expect(result.rows.every((r) => r.features.poolAgeMinutes === null)).toBe(
    true,
  );
});

it('requires an explicitly registered holdout and keeps genuine forward as its own source', () => {
  expect(
    parseAnalyticsArguments(['report', '--source', 'forward'])?.selection
      .source,
  ).toBe('forward');
  expect(() =>
    parseAnalyticsArguments([
      'report',
      '--source',
      'synthetic',
      '--type',
      'holdout',
    ]),
  ).toThrow('prospective registration');
  expect(() =>
    parseAnalyticsArguments([
      'report',
      '--start',
      '2026-01-02',
      '--end',
      '2026-01-01',
    ]),
  ).toThrow('precede');
});
