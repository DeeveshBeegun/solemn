import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { backtestConfig, backtestSetup } from './backtestFixtures.js';
import { stableHash, stableId } from '@solemn/shared';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
describe('Week 6 chronological backtest', () => {
  it('runs all six cases, retains uncertain exposure, and accounts for delayed entries/exits', async () => {
    const setup = await backtestSetup();
    const result = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    expect(result.metrics.strategy.positionsOpened).toBe(3);
    expect(result.metrics.trading.closedPositions).toBe(2);
    expect(result.metrics.trading.winningClosedPositions).toBe(1);
    expect(result.metrics.trading.losingClosedPositions).toBe(1);
    expect(result.metrics.trading.winRatePercent).toBe('50');
    expect(result.metrics.strategy.takeProfitExits).toBe(2);
    expect(result.metrics.strategy.stopLossExits).toBe(1);
    expect(result.metrics.strategy.trailingStopExits).toBe(1);
    expect(result.metrics.strategy.failedExitAttempts).toBe(1);
    expect(result.metrics.portfolio.endingMarkedEquityUsd).toBeNull();
    expect(result.metrics.baseline.strategyMinusBaselineUsd).toBeNull();
    expect(
      result.finalState.positions.find(
        (position) => position.status === 'EXIT_BLOCKED',
      ),
    ).toMatchObject({ closedAt: null });
    for (const intent of setup.store.intents.values())
      if (
        intent.status === 'FILLED' ||
        (intent.status === 'FAILED' && intent.orderId)
      ) {
        expect(Date.parse(intent.attemptedAt!)).toBeGreaterThanOrEqual(
          Date.parse(intent.dueAt),
        );
        expect(Date.parse(intent.attemptedAt!)).toBeGreaterThan(
          Date.parse(intent.triggerAt),
        );
      }
    expect(result.metrics.trading.profitFactor.value).not.toBeNull();
  });
  it('reproduces economic results in a separate isolated run and caches completed repeats', async () => {
    const setup = await backtestSetup('winner');
    const first = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    const repeated = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    expect(repeated).toEqual(first);
    const otherPlan = createBacktestPlan(
      { dataset: 'fixtures', runId: stableId(['independent-backtest']) },
      setup.dataset,
      backtestConfig,
    );
    const other = await runBacktest(
      otherPlan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    expect(other.metrics).toEqual(first.metrics);
    const strip = (state: typeof first.finalState) => ({
      ...state,
      id: '',
      positions: state.positions.map((position) => ({
        ...position,
        id: '',
        portfolioId: '',
        signalId: '',
      })),
    });
    expect(strip(other.finalState)).toEqual(strip(first.finalState));
    expect(first.metrics.trading.profitFactor).toEqual({
      value: null,
      reason: 'NO_LOSING_CLOSED_POSITIONS',
    });
    expect(first.metrics.portfolio.endingMarkedEquityUsd).toBe(
      first.finalState.availableCashUsd,
    );
    const curve = [...setup.store.snapshots.values()].filter(
      (snapshot) => snapshot.runId === setup.plan.runId,
    );
    expect(
      curve.every(
        (snapshot) =>
          snapshot.timestamp >= setup.plan.startTime &&
          snapshot.timestamp <= setup.plan.endTime,
      ),
    ).toBe(true);
    expect(stableHash(first.metrics)).toBe(stableHash(other.metrics));
  });
  it('produces a zero-trade baseline result with undefined closed-trade ratios', async () => {
    const setup = await backtestSetup('zero-trade');
    const result = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    expect(result.finalState.positions).toHaveLength(0);
    expect(result.metrics.portfolio.endingCashUsd).toBe('100');
    expect(result.metrics.trading.winRatePercent).toBeNull();
    expect(result.metrics.trading.profitFactor).toEqual({
      value: null,
      reason: 'NO_CLOSED_POSITIONS',
    });
    expect(result.metrics.baseline.strategyMinusBaselineUsd).toBe('0');
  });
  it('reconstructs an interrupted run after a persisted partial exit without duplicating fills', async () => {
    const setup = await backtestSetup('winner');
    let interrupted = false;
    const paper = setup.services.paper;
    const failing = {
      ...paper,
      async transact(...args: Parameters<typeof paper.transact>) {
        const saved = await paper.transact(...args);
        if (
          !interrupted &&
          saved.orders.some(
            (record) =>
              record.reason === 'TAKE_PROFIT_1' &&
              record.order.status === 'FILLED',
          )
        ) {
          interrupted = true;
          throw new Error('INTERRUPTED_AFTER_PERSISTED_FILL');
        }
        return saved;
      },
    };
    await expect(
      runBacktest(setup.plan, setup.provider, backtestConfig, {
        ...setup.services,
        paper: failing,
      }),
    ).rejects.toThrow('INTERRUPTED_AFTER_PERSISTED_FILL');
    const frontier = await paper.load(setup.plan.portfolioId);
    expect(frontier.state.positions[0]!.target1Complete).toBe(true);
    const resumed = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    const clean = await backtestSetup('winner');
    const complete = await runBacktest(
      clean.plan,
      clean.provider,
      backtestConfig,
      clean.services,
    );
    expect(resumed).toEqual(complete);
    expect(
      setup.store.paper.events.flatMap((event) => event.orders),
    ).toHaveLength(4);
  });
});
