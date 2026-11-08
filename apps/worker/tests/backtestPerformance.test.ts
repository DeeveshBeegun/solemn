import { describe, expect, it } from 'vitest';
import { PerformanceAnalyzer } from '../src/backtesting/performanceAnalyzer.js';
import { initialPortfolio } from '../src/portfolio/accountingService.js';
import { paperDefinition } from '../src/portfolio/paperReplay.js';
import { createPaperReplayFixture } from '../src/portfolio/replayFixture.js';
import { paperEntrySetup } from './paperFixtures.js';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import { backtestConfig, backtestSetup } from './backtestFixtures.js';
import { replayTime } from '../src/strategy/replayFixture.js';
import { stableId } from '@solemn/shared';
describe('closed-position performance and equity uncertainty', () => {
  it('uses closed positions only and correct denominators for win rate, expectancy, return and profit factor', async () => {
    const setup = await backtestSetup('winner'),
      entry = await paperEntrySetup(),
      opened = applyPaperCommand(entry.state, entry.command, entry.definition)
        .state.positions[0]!;
    const win = {
      ...opened,
      id: stableId(['metric-win']),
      status: 'CLOSED' as const,
      quantity: '0',
      initialCostBasisUsd: '100',
      costBasisUsd: '0',
      realizedPnlUsd: '10',
      closedAt: replayTime(15, 5000),
    };
    const loss = {
      ...win,
      id: stableId(['metric-loss']),
      realizedPnlUsd: '-5',
      closedAt: replayTime(16, 5000),
    };
    const unresolved = {
      ...opened,
      id: stableId(['unresolved']),
      realizedPnlUsd: '999',
      valuationStale: true,
    };
    const state = {
      ...entry.state,
      positions: [win, loss, unresolved],
      realizedPnlUsd: '5',
    };
    const analyzer = new PerformanceAnalyzer(setup.plan),
      point = analyzer.snapshot(state, replayTime(17));
    const metrics = analyzer.finish(state, point, setup.dataset);
    expect(metrics.trading.winRatePercent).toBe('50');
    expect(metrics.trading.averageWinningReturnPercent).toBe('10');
    expect(metrics.trading.averageLosingReturnPercent).toBe('-5');
    expect(metrics.trading.expectancyUsd).toBe('2.5');
    expect(metrics.trading.medianPositionReturnPercent).toBe('2.5');
    expect(metrics.trading.profitFactor).toEqual({ value: '2', reason: null });
    expect(metrics.trading.averageHoldingSeconds).toBe('90');
    expect(metrics.portfolio.endingMarkedEquityUsd).toBeNull();
    expect(metrics.baseline.strategyMinusBaselineUsd).toBeNull();
  });
  it('measures maximum drawdown from the running reliable peak rather than only the ending account drawdown', async () => {
    const setup = await backtestSetup('winner'),
      definition = paperDefinition(
        backtestConfig,
        setup.plan.strategyRunId,
        createPaperReplayFixture(backtestConfig),
      ),
      state = initialPortfolio(definition),
      analyzer = new PerformanceAnalyzer(setup.plan);
    analyzer.snapshot({ ...state, equityUsd: '100' }, replayTime(0));
    analyzer.snapshot({ ...state, equityUsd: '120' }, replayTime(1));
    analyzer.snapshot({ ...state, equityUsd: '90' }, replayTime(2));
    const last = analyzer.snapshot(
        { ...state, equityUsd: '110' },
        replayTime(3),
      ),
      metrics = analyzer.finish(state, last, setup.dataset);
    expect(metrics.portfolio.maximumDrawdownPercent).toBe('25');
    expect(metrics.portfolio.peakReliableEquityUsd).toBe('120');
    expect(last.drawdownPercent).toBe('8.333333333333333333');
  });
});
