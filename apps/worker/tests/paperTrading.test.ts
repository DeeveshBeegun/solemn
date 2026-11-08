import { describe, expect, it } from 'vitest';
import { fromAtomic, stableHash, stableId, toAtomic } from '@solemn/shared';
import { replayPaperTrading } from '../src/portfolio/paperReplay.js';
import { createPaperReplayFixture } from '../src/portfolio/replayFixture.js';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import { recoverPortfolio } from '../src/portfolio/recovery.js';
import { createPositionMonitor } from '../src/portfolio/positionMonitor.js';
import { memoryStrategyRepository } from './strategyFixtures.js';
import {
  paperConfig,
  paperEntrySetup,
  memoryPaperRepository,
} from './paperFixtures.js';
import { replayTime } from '../src/strategy/replayFixture.js';

describe('Week 5 deterministic paper portfolio', () => {
  it('reconciles entry, staged exits, trailing close, fees and repeat/restart without duplicate execution', async () => {
    const fixture = createPaperReplayFixture(paperConfig),
      strategyStore = memoryStrategyRepository(),
      store = memoryPaperRepository();
    const result = await replayPaperTrading(
      fixture,
      paperConfig,
      strategyStore.repository,
      store.repository,
    );
    expect(result.outcomes).toEqual([
      'ENTRY_FILLED',
      'MARK_UPDATED',
      'EXIT_FILLED',
      'EXIT_FILLED',
      'MARK_UPDATED',
      'EXIT_FILLED',
    ]);
    const state = result.state,
      position = state.positions[0]!;
    expect(position).toMatchObject({
      status: 'CLOSED',
      quantity: '0',
      costBasisUsd: '0',
      target1Complete: true,
      target2Complete: true,
    });
    const records = store.events.flatMap((event) => event.orders),
      buys = records.filter((record) => record.order.side === 'BUY'),
      sells = records.filter((record) => record.order.side === 'SELL');
    expect(records).toHaveLength(4);
    expect(
      toAtomic(buys[0]!.notionalUsd) + toAtomic(buys[0]!.trades[0]!.feesUsd),
    ).toBeLessThanOrEqual(toAtomic('1'));
    const buyCost = buys.reduce(
      (sum, record) =>
        sum +
        toAtomic(record.notionalUsd) +
        toAtomic(record.trades[0]!.feesUsd),
      0n,
    );
    const sellNet = sells.reduce(
      (sum, record) =>
        sum +
        toAtomic(record.notionalUsd) -
        toAtomic(record.trades[0]!.feesUsd),
      0n,
    );
    expect(state.availableCashUsd).toBe(
      fromAtomic(toAtomic('100') - buyCost + sellNet),
    );
    expect(state.realizedPnlUsd).toBe(fromAtomic(sellNet - buyCost));
    expect(state.equityUsd).toBe(state.availableCashUsd);
    expect(toAtomic(state.buyFeesUsd)).toBe(
      buys.reduce(
        (sum, record) => sum + toAtomic(record.trades[0]!.feesUsd),
        0n,
      ),
    );
    expect(toAtomic(state.sellFeesUsd)).toBe(
      sells.reduce(
        (sum, record) => sum + toAtomic(record.trades[0]!.feesUsd),
        0n,
      ),
    );
    expect(state.unrealizedPnlUsd).toBe('0');
    expect(state.reservedCashUsd).toBe('0');
    expect(
      sells.reduce(
        (sum, record) => sum + toAtomic(record.request.quantity),
        0n,
      ),
    ).toBe(toAtomic(position.originalQuantity));
    const recovered = await recoverPortfolio(
      store.repository,
      result.definition.id,
    );
    expect(recovered.state).toEqual(state);
    const repeated = await replayPaperTrading(
      fixture,
      paperConfig,
      strategyStore.repository,
      store.repository,
    );
    expect(repeated.state).toEqual(state);
    expect(repeated.duplicates).toBe(6);
    expect(store.events.flatMap((event) => event.orders)).toHaveLength(4);
  });
  it('keeps a failed stop-loss open and visible, then resumes a protective exit while halted', async () => {
    const store = memoryPaperRepository();
    const result = await replayPaperTrading(
      createPaperReplayFixture(paperConfig, 'blocked-stop'),
      paperConfig,
      memoryStrategyRepository().repository,
      store.repository,
    );
    expect(result.outcomes.at(-1)).toBe('EXIT_FAILED');
    const position = result.state.positions[0]!;
    expect(position.status).toBe('EXIT_BLOCKED');
    expect(position.quantity).toBe(position.originalQuantity);
    expect(position.closedAt).toBeNull();
    expect(position.pendingExitReason).toBe('STOP_LOSS');
    expect(position.blockedReason).toBe('LIQUIDITY_UNAVAILABLE');
    expect(result.state.realizedPnlUsd).toBe('0');
    const at = replayTime(17, 5000),
      halt = {
        type: 'HALT' as const,
        id: stableId(['halt-test']),
        at,
        reason: 'TEST_ADMINISTRATIVE_HALT',
      };
    await store.repository.transact(
      result.definition.id,
      halt,
      (state, definition) => applyPaperCommand(state, halt, definition),
    );
    const quote = {
      ...createPaperReplayFixture(paperConfig, 'blocked-stop').observations.at(
        -1,
      )!,
      id: stableId(['liquidity-restored']),
      liquidityUsd: '50000',
      observedAt: replayTime(18, 5000),
      receivedAt: replayTime(18, 5000),
    };
    const exited = await createPositionMonitor(
      result.definition.id,
      store.repository,
    ).observe(quote, null);
    expect(exited.result.outcome).toBe('EXIT_FILLED');
    expect(exited.state.positions[0]!.status).toBe('CLOSED');
    expect(exited.state.status).toBe('HALTED');
  });
  it('requires fixture opt-in and detects altered journal evidence during recovery', async () => {
    const fixture = createPaperReplayFixture(paperConfig),
      store = memoryPaperRepository();
    await expect(
      replayPaperTrading(
        fixture,
        { ...paperConfig, PAPER_ALLOW_FIXTURE_SIGNALS: false },
        memoryStrategyRepository().repository,
        store.repository,
      ),
    ).rejects.toThrow('explicit fixture opt-in');
    const result = await replayPaperTrading(
      fixture,
      paperConfig,
      memoryStrategyRepository().repository,
      store.repository,
    );
    store.events[1]!.stateAfter.availableCashUsd = '1000';
    await expect(
      recoverPortfolio(store.repository, result.definition.id),
    ).rejects.toThrow('hash/sequence');
  });
  it('releases reserved cash on transaction failure and never records a phantom fill', async () => {
    const setup = await paperEntrySetup();
    setup.command.observation!.simulationOutcome = 'TRANSACTION_FAILURE';
    const result = applyPaperCommand(
      setup.state,
      setup.command,
      setup.definition,
    );
    expect(result.state.availableCashUsd).toBe('100');
    expect(result.state.reservedCashUsd).toBe('0');
    expect(result.state.positions).toHaveLength(0);
    expect(result.orders[0]!.order.status).toBe('FAILED');
    expect(result.orders[0]!.trades).toHaveLength(0);
    expect(result.postings.map((posting) => posting.type)).toEqual([
      'RESERVE',
      'RELEASE',
    ]);
  });
  it('preserves the last valid quote during stale/disconnected periods and consumes no future price', async () => {
    const setup = await paperEntrySetup(),
      entered = applyPaperCommand(setup.state, setup.command, setup.definition);
    const quote = setup.fixture.observations[1]!,
      mark = {
        type: 'MARK' as const,
        id: stableId(['paper-mark-v1', setup.definition.id, quote.id]),
        at: quote.receivedAt,
        observation: quote,
        risk: null,
      };
    const marked = applyPaperCommand(entered.state, mark, setup.definition);
    const stale = applyPaperCommand(
      marked.state,
      { type: 'TICK', id: stableId(['stale']), at: replayTime(16) },
      setup.definition,
    );
    expect(stale.state.positions[0]!.mark).toEqual(quote);
    expect(stale.state.positions[0]!.valuationStale).toBe(true);
    expect(stale.orders).toHaveLength(0);
    const future = {
      ...quote,
      id: stableId(['future']),
      priceUsd: '1000',
      observedAt: replayTime(17),
      receivedAt: replayTime(17),
    };
    const unavailable = applyPaperCommand(
      marked.state,
      {
        ...mark,
        id: stableId(['paper-mark-v1', setup.definition.id, future.id]),
        at: replayTime(16),
        observation: future,
      },
      setup.definition,
    );
    expect(unavailable.result.reasons).toContain('OBSERVATION_IN_FUTURE');
    expect(unavailable.state.positions[0]!.trailingPeakUsd).toBeNull();
    expect(stableHash(unavailable.state.positions[0]!.mark)).toBe(
      stableHash(quote),
    );
  });
});
