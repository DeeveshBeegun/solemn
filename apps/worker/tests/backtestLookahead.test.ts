import { describe, expect, it } from 'vitest';
import { multiplyDecimal, stableId, historicalSortKey } from '@solemn/shared';
import type { HistoricalEvent, StrategyDecision } from '@solemn/shared';
import { createBacktestFixture } from '../src/backtesting/replayFixture.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { backtestConfig, backtestSetup } from './backtestFixtures.js';
import { replayTime } from '../src/strategy/replayFixture.js';
const at = replayTime;
const normalize = (decision: StrategyDecision) => ({
  ...decision,
  id: '',
  runId: '',
  candidate: decision.candidate ? { ...decision.candidate, id: '' } : null,
});
const sort = (events: HistoricalEvent[]) =>
  events.sort((a, b) =>
    historicalSortKey(a).localeCompare(historicalSortKey(b)),
  );
describe('historical information availability', () => {
  it('keeps future prices, liquidity and candle highs out of earlier signals, fills and equity', async () => {
    const original = await backtestSetup('winner'),
      first = await runBacktest(
        original.plan,
        original.provider,
        backtestConfig,
        original.services,
      );
    const file = createBacktestFixture(backtestConfig, 'winner');
    for (const event of file.events)
      if (Date.parse(event.availableAt) >= Date.parse(at(17))) {
        if (event.kind === 'TRADE') {
          event.data.priceUsd = '10000';
          event.data.volumeUsd = multiplyDecimal(
            event.data.tokenAmount,
            '10000',
          );
          event.data.quoteAmount = event.data.volumeUsd;
        }
        if (event.kind === 'EXECUTION') {
          event.data.priceUsd = '1';
          event.data.liquidityUsd = '0';
        }
      }
    const changed = await backtestSetup('winner', file);
    await runBacktest(
      changed.plan,
      changed.provider,
      backtestConfig,
      changed.services,
    );
    const before = (decisions: Map<string, StrategyDecision>) =>
      [...decisions.values()]
        .filter((decision) => decision.timestamp < at(17))
        .map(normalize);
    expect(before(changed.strategy.decisions)).toEqual(
      before(original.strategy.decisions),
    );
    const fills = (events: typeof original.store.paper.events) =>
      events
        .filter((event) => event.timestamp < at(17))
        .flatMap((event) => event.orders)
        .map((record) => ({
          side: record.order.side,
          at: record.order.createdAt,
          quantity: record.order.requestedQuantity,
          notional: record.notionalUsd,
          price: record.trades[0]?.executionPriceUsd,
          fees: record.order.actualFeesUsd,
        }));
    expect(fills(changed.store.paper.events)).toEqual(
      fills(original.store.paper.events),
    );
    expect(first.metrics.strategy.takeProfitExits).toBe(2);
    const earlySells = changed.store.paper.events
      .flatMap((event) => event.orders)
      .filter((record) => record.order.side === 'SELL');
    expect(
      earlySells.every((record) => record.order.createdAt >= at(16, 6000)),
    ).toBe(true);
  });
  it('never uses a future eligible assessment or future pool-creation visibility to approve an earlier signal', async () => {
    for (const missing of ['risk', 'pool'] as const) {
      const file = createBacktestFixture(backtestConfig, 'winner');
      if (missing === 'risk')
        file.events = file.events.filter(
          (event) => event.kind !== 'RISK' || event.availableAt >= at(16),
        );
      else file.manifest.markets[0]!.poolCreationAvailableAt = at(16);
      const setup = await backtestSetup('winner', file);
      await runBacktest(
        setup.plan,
        setup.provider,
        backtestConfig,
        setup.services,
      );
      expect(
        [...setup.strategy.decisions.values()]
          .filter((decision) => decision.timestamp < at(16))
          .every((decision) => decision.candidate === null),
      ).toBe(true);
      expect(
        setup.store.paper.events
          .flatMap((event) => event.orders)
          .filter(
            (record) =>
              record.order.side === 'BUY' && record.order.createdAt < at(16),
          ),
      ).toHaveLength(0);
    }
  });
  it('cannot borrow a pre-signal quote or later liquidity to fill a historical entry', async () => {
    const file = createBacktestFixture(backtestConfig, 'winner'),
      entry = file.events.find(
        (event) => event.kind === 'EXECUTION' && event.data.side === 'BUY',
      )!;
    if (entry.kind !== 'EXECUTION') throw new Error('Missing fixture quote');
    entry.eventAt = at(14, 4000);
    entry.availableAt = at(14, 4000);
    entry.data.observedAt = entry.eventAt;
    entry.data.receivedAt = entry.availableAt;
    const later = structuredClone(entry);
    later.id = stableId(['too-late-buy']);
    later.data.id = stableId(['too-late-buy-quote']);
    later.eventAt = at(15);
    later.availableAt = at(15);
    later.data.observedAt = later.eventAt;
    later.data.receivedAt = later.availableAt;
    later.data.liquidityUsd = '100000000';
    file.events.push(later);
    sort(file.events);
    const setup = await backtestSetup('winner', file),
      result = await runBacktest(
        setup.plan,
        setup.provider,
        backtestConfig,
        setup.services,
      );
    expect(result.metrics.strategy.positionsOpened).toBe(0);
    expect(result.metrics.strategy.signalsWithoutExecutionObservations).toBe(1);
    expect(
      [...setup.store.intents.values()].find(
        (intent) => intent.kind === 'ENTRY',
      )?.status,
    ).toBe('EXPIRED');
  });
  it('uses the next delayed exit observation price and never fills on the stop-triggering quote', async () => {
    const file = createBacktestFixture(backtestConfig),
      market = file.manifest.markets[1]!;
    const execute = file.events.find(
      (event) =>
        event.kind === 'EXECUTION' &&
        event.mint === market.mint &&
        event.availableAt === at(15, 1000),
    )!;
    if (execute.kind !== 'EXECUTION') throw new Error('Missing stop quote');
    execute.data.priceUsd = '70';
    const setup = await backtestSetup('all', file);
    await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    const stop = setup.store.paper.events
      .flatMap((event) => event.orders)
      .find(
        (record) =>
          record.reason === 'STOP_LOSS' &&
          record.order.tokenMint === market.mint,
      )!;
    expect(stop.order.createdAt).toBe(at(15, 1000));
    expect(stop.trades[0]?.executionPriceUsd).toBe('69.3');
  });
  it('timestamps decisions after all required candle, risk and trade inputs', async () => {
    const setup = await backtestSetup('winner');
    await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    for (const decision of setup.strategy.decisions.values())
      if (decision.candidate) {
        const time = Date.parse(decision.timestamp);
        expect(Date.parse(decision.risk!.availableAt)).toBeLessThanOrEqual(
          time,
        );
        for (const candle of setup.strategy.candles.values())
          if (decision.sourceRefs.includes(candle.id)) {
            expect(Date.parse(candle.endTime)).toBeLessThanOrEqual(time);
            expect(Date.parse(candle.finalizedAt)).toBeLessThanOrEqual(time);
          }
        for (const event of setup.file.events)
          if (
            event.kind === 'TRADE' &&
            decision.sourceRefs.includes(event.data.id)
          )
            expect(Date.parse(event.availableAt)).toBeLessThanOrEqual(time);
      }
  });
  it('leaves an open position unpriced at replay end rather than fabricating a closing sale', async () => {
    const setup = await backtestSetup('winner', undefined, { endTime: at(15) }),
      result = await runBacktest(
        setup.plan,
        setup.provider,
        backtestConfig,
        setup.services,
      );
    expect(result.metrics.trading.closedPositions).toBe(0);
    expect(result.finalState.positions[0]!.status).toBe('OPEN');
    expect(result.metrics.portfolio.endingMarkedEquityUsd).toBeNull();
    expect(result.metrics.dataQuality.unpricedOpenPositions).toBe(1);
    expect(result.metrics.portfolio.realizedNetPnlUsd).toBe('0');
  });
});
