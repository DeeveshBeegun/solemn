import { describe, expect, it } from 'vitest';
import { stableId } from '@solemn/shared';
import type { PaperCommand } from '@solemn/shared';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import { entryRiskReasons } from '../src/risk/riskManager.js';
import { chooseExit } from '../src/portfolio/positionManager.js';
import { createPositionMonitor } from '../src/portfolio/positionMonitor.js';
import { recoverPortfolio } from '../src/portfolio/recovery.js';
import {
  paperConfig,
  paperEntrySetup,
  memoryPaperRepository,
} from './paperFixtures.js';
import { loadConfig } from '../src/config/index.js';
import { replayTime } from '../src/strategy/replayFixture.js';

describe('paper entry risk gates', () => {
  it.each([
    'rejected',
    'unknown',
    'stale-risk',
    'new-request',
    'policy',
    'version',
    'old-signal',
    'future-signal',
    'market',
    'halted',
    'balance',
    'existing-position',
    'max-positions',
  ] as const)('blocks %s before creating an order', async (mode) => {
    const { command, state, definition } = await paperEntrySetup();
    if (mode === 'rejected') command.risk!.currentStatus = 'REJECTED';
    if (mode === 'unknown') command.risk!.currentStatus = 'UNKNOWN';
    if (mode === 'stale-risk')
      command.risk!.assessment!.validUntil = replayTime(14);
    if (mode === 'new-request') command.risk!.currentRequestId = null;
    if (mode === 'policy')
      command.risk!.assessment!.policyHash = 'f'.repeat(64);
    if (mode === 'version') command.candidate.strategyVersion = 'unsupported';
    if (mode === 'old-signal') command.candidate.timestamp = replayTime(10);
    if (mode === 'future-signal') command.candidate.timestamp = replayTime(15);
    if (mode === 'market') command.observation!.healthy = false;
    if (mode === 'halted') {
      state.status = 'HALTED';
      state.haltReason = 'TEST';
    }
    if (mode === 'balance') state.availableCashUsd = '0';
    if (mode === 'existing-position' || mode === 'max-positions') {
      const entered = applyPaperCommand(state, command, definition).state;
      state.positions =
        mode === 'existing-position'
          ? entered.positions
          : Array.from({ length: 3 }, (_, index) => ({
              ...entered.positions[0]!,
              mint: stableId(['ignored-mint', index]),
            }));
    }
    // Entry gates are independent of accounting: synthetic exposure states exercise the limit checks directly.
    if (['existing-position', 'max-positions', 'balance'].includes(mode))
      expect(
        entryRiskReasons(command, state, definition).length,
      ).toBeGreaterThan(0);
    else {
      const result = applyPaperCommand(state, command, definition);
      expect(result.result.outcome).toBe('ENTRY_REJECTED');
      expect(result.orders).toHaveLength(0);
    }
  });
  it('validates percentages, fee bounds, staged targets and impossible allocations', () => {
    expect(paperConfig.PAPER_TRADING_ENABLED).toBe(false);
    for (const override of [
      { PAPER_BUY_FEE_PERCENT: '-1' },
      { PAPER_BASELINE_SLIPPAGE_PERCENT: '100' },
      { PAPER_MAX_POSITION_PERCENT: '101' },
      { PAPER_MAX_POSITION_PERCENT: '40', PAPER_MAX_OPEN_POSITIONS: '3' },
      { PAPER_TAKE_PROFIT_1_SELL_FRACTION: '0' },
      { PAPER_STOP_LOSS_PERCENT: '100' },
      { PAPER_MAX_DAILY_LOSS_PERCENT: '0' },
      { PAPER_TAKE_PROFIT_2_PERCENT: '50' },
      { PAPER_QUANTITY_DECIMALS: '19' },
      { PAPER_MIN_ORDER_USD: '2' },
      { PAPER_SELL_FEE_PERCENT: 'NaN' },
    ])
      expect(() =>
        loadConfig({ DATABASE_URL: paperConfig.DATABASE_URL, ...override }),
      ).toThrow();
  });
});
describe('position exits and account loss controls', () => {
  it('gives critical risk, stop, trailing and expiration precedence over profit targets', async () => {
    const { command, state, definition } = await paperEntrySetup();
    const position = applyPaperCommand(state, command, definition).state
        .positions[0]!,
      policy = definition.policy;
    expect(
      chooseExit(position, '300', replayTime(15), policy, true)?.reason,
    ).toBe('CRITICAL_TOKEN_RISK');
    expect(
      chooseExit(position, '90', replayTime(100), policy, false)?.reason,
    ).toBe('STOP_LOSS');
    position.target1Complete = true;
    position.target2Complete = true;
    position.trailingPeakUsd = '600';
    expect(
      chooseExit(position, '350', replayTime(100), policy, false)?.reason,
    ).toBe('TRAILING_STOP');
    position.target2Complete = false;
    expect(
      chooseExit(position, '350', replayTime(100), policy, false)?.reason,
    ).toBe('MAX_HOLDING_TIME');
  });
  it('blocks new entries at daily loss, keeps protective exits enabled and resets the daily baseline on a new UTC day', async () => {
    const setup = await paperEntrySetup();
    setup.definition.policy.maxDailyLossPercent = '0.1';
    const opened = applyPaperCommand(
      setup.state,
      setup.command,
      setup.definition,
    );
    const quote = { ...setup.fixture.observations[1]!, priceUsd: '115' };
    const mark: PaperCommand = {
      type: 'MARK',
      id: stableId(['paper-mark-v1', setup.definition.id, quote.id]),
      at: quote.receivedAt,
      observation: quote,
      risk: null,
    };
    const lost = applyPaperCommand(opened.state, mark, setup.definition);
    expect(lost.state.status).toBe('ENTRIES_BLOCKED');
    expect(lost.state.entryBlockReasons).toContain('DAILY_LOSS_LIMIT');
    const stopQuote = {
      ...quote,
      id: stableId(['daily-protective-stop']),
      priceUsd: '80',
      observedAt: replayTime(16),
      receivedAt: replayTime(16),
    };
    const exited = applyPaperCommand(
      lost.state,
      {
        ...mark,
        id: stableId(['paper-mark-v1', setup.definition.id, stopQuote.id]),
        at: stopQuote.receivedAt,
        observation: stopQuote,
      },
      setup.definition,
    );
    expect(exited.result.outcome).toBe('EXIT_FILLED');
    expect(exited.state.positions[0]!.status).toBe('CLOSED');
    const nextDay = applyPaperCommand(
      exited.state,
      {
        type: 'TICK',
        id: stableId(['next-day']),
        at: '2026-01-02T00:00:00.000Z',
      },
      setup.definition,
    );
    expect(nextDay.state.dailyLossPercent).toBe('0');
    expect(nextDay.state.status).toBe('ACTIVE');
  });
  it('latches total drawdown until an explicit administrative reset', async () => {
    const setup = await paperEntrySetup();
    setup.definition.policy.maxTotalDrawdownPercent = '0.1';
    const entered = applyPaperCommand(
      setup.state,
      setup.command,
      setup.definition,
    );
    const quote = { ...setup.fixture.observations[1]!, priceUsd: '115' };
    const mark = {
      type: 'MARK' as const,
      id: stableId(['paper-mark-v1', setup.definition.id, quote.id]),
      at: quote.receivedAt,
      observation: quote,
      risk: null,
    };
    const halted = applyPaperCommand(entered.state, mark, setup.definition);
    expect(halted.state.status).toBe('HALTED');
    expect(halted.state.haltReason).toBe('TOTAL_DRAWDOWN_LIMIT');
    const recoveredQuote = {
      ...quote,
      id: stableId(['price-recovers']),
      priceUsd: '130',
      observedAt: replayTime(15, 6000),
      receivedAt: replayTime(15, 6000),
    };
    const recovered = applyPaperCommand(
      halted.state,
      {
        ...mark,
        id: stableId(['paper-mark-v1', setup.definition.id, recoveredQuote.id]),
        at: recoveredQuote.receivedAt,
        observation: recoveredQuote,
      },
      setup.definition,
    );
    expect(recovered.state.status).toBe('HALTED');
    const reset = applyPaperCommand(
      recovered.state,
      {
        type: 'RESET_HALT',
        id: stableId(['admin-reset']),
        at: replayTime(15, 7000),
        reason: 'EXPLICIT_OPERATOR_REVIEW',
      },
      setup.definition,
    );
    expect(reset.state.status).toBe('ACTIVE');
    expect(reset.result.outcome).toBe('RESET');
  });
  it('recovers partially exited quantities and trailing activation without resetting targets', async () => {
    const setup = await paperEntrySetup(),
      store = memoryPaperRepository();
    await store.repository.initialize(
      setup.definition,
      setup.state,
      setup.posting,
    );
    await store.repository.transact(
      setup.definition.id,
      setup.command,
      (state, definition) =>
        applyPaperCommand(state, setup.command, definition),
    );
    const monitor = createPositionMonitor(
      setup.definition.id,
      store.repository,
    );
    await monitor.observe(setup.fixture.observations[1]!, null);
    await monitor.observe(setup.fixture.observations[2]!, null);
    const firstRecovery = await recoverPortfolio(
      store.repository,
      setup.definition.id,
    );
    expect(firstRecovery.state.positions[0]!.target1Complete).toBe(true);
    expect(firstRecovery.state.positions[0]!.target2Complete).toBe(false);
    await createPositionMonitor(setup.definition.id, store.repository).observe(
      setup.fixture.observations[3]!,
      null,
    );
    const secondRecovery = await recoverPortfolio(
      store.repository,
      setup.definition.id,
    );
    expect(secondRecovery.state.positions[0]!.target2Complete).toBe(true);
    expect(secondRecovery.state.positions[0]!.trailingPeakUsd).toBe('346.5');
  });
});
