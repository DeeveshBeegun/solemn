import { paperPolicy } from '../src/portfolio/policy.js';
import { describe, expect, it } from 'vitest';
import {
  fromAtomic,
  stableId,
  toAtomic,
  executionConfigSchema,
  poolSnapshotSchema,
  compareHistoricalEvents,
} from '@solemn/shared';
import type { ExecutionContext, PoolSnapshot } from '@solemn/shared';
import {
  quoteExactInput,
  quoteExactOutput,
} from '../src/execution/simulation/poolModels.js';
import {
  buyQuantity,
  prepareQuote,
  simulateExecution,
} from '../src/execution/simulation/executionSimulator.js';
import { networkFees } from '../src/execution/simulation/feeModel.js';
import { executionScenario } from '../src/execution/simulation/executionScenarios.js';
import { createStressFixture } from '../src/backtesting/stressScenarios.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { backtestConfig, backtestSetup } from './backtestFixtures.js';
import { PaperExecutor } from '../src/execution/paperExecutor.js';
const id = (key: string) => stableId(['execution-test', key]);
const t = '2026-01-01T00:00:00.000Z',
  land = '2026-01-01T00:00:01.000Z';
const initialFixture = createStressFixture(backtestConfig);
function pool(): PoolSnapshot {
  const p = initialFixture.events.find((e) => e.kind === 'EXECUTION')!;
  if (p.kind !== 'EXECUTION') throw new Error('Fixture');
  return {
    ...p.data.pool!,
    id: id('pool'),
    baseReserve: '1000000000000',
    quoteReserve: '1000000000',
    observedAt: t,
    availableAt: t,
    fees: {
      ...p.data.pool!.fees,
      validFrom: '2025-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      lpBps: 0,
      protocolBps: 0,
    },
  };
}
function context(side: 'BUY' | 'SELL' = 'BUY'): ExecutionContext {
  const p = pool(),
    config = executionScenario('baseline');
  return {
    runId: id('run'),
    config,
    quote: prepareQuote(p, side, '1', t, t, land, config),
    pool: { ...p, id: id('landing'), observedAt: land, availableAt: land },
    nativeUsd: {
      priceUsd: '150',
      observedAt: land,
      availableAt: land,
      source: 'SYNTHETIC',
    },
    randomKey: 'same-order',
  };
}
describe('reference constant-product integer math', () => {
  it('quotes both directions and preserves the invariant without mutating source', () => {
    const p = pool(),
      before = structuredClone(p);
    const q = quoteExactInput(p, 'BUY', 1000000n);
    expect(q.output).toBe(999000999n);
    expect(
      BigInt(q.updatedPool.baseReserve) * BigInt(q.updatedPool.quoteReserve),
    ).toBeGreaterThanOrEqual(BigInt(p.baseReserve) * BigInt(p.quoteReserve));
    expect(quoteExactInput(p, 'SELL', 1000000000n).output).toBe(999000n);
    expect(p).toEqual(before);
    expect(quoteExactOutput(p, 'BUY', 1000000000n).output).toBe(1000000000n);
  });
  it('shows increasing curve impact for $1/$5/$10/$25/$50', () => {
    const impacts = [1n, 5n, 10n, 25n, 50n].map((n) =>
      toAtomic(quoteExactInput(pool(), 'BUY', n * 1000000n).impactBps),
    );
    expect(impacts.every((n, i) => i === 0 || n > impacts[i - 1]!)).toBe(true);
  });
  it('separates fee recipients, transfer fees and retained LP reserves', () => {
    const p = pool();
    p.fees.lpBps = 25;
    p.fees.protocolBps = 5;
    p.fees.creatorBps = 10;
    p.quoteTransferFee = { bps: 100, maximumUnits: '5000' };
    const q = quoteExactInput(p, 'BUY', 1000000n);
    expect(q.fees.map((f) => f.category)).toEqual([
      'TRANSFER',
      'LP',
      'PROTOCOL',
      'CREATOR',
    ]);
    expect(q.fees.find((f) => f.category === 'TRANSFER')?.amountUnits).toBe(
      '5000',
    );
    expect(q.updatedPool.quoteReserve).toBe(
      String(1000000000n + 995000n - 498n - 995n),
    );
  });
  it.each([
    'CLMM',
    'DLMM',
    'MULTIHOP',
    'PUMP_BONDING',
    'PUMPSWAP',
    'UNKNOWN',
  ] as const)('rejects unsupported %s', (model) =>
    expect(() =>
      quoteExactInput({ ...pool(), model }, 'BUY', 1000000n),
    ).toThrow('UNSUPPORTED'),
  );
  it('rejects zero, invalid, tiny and insufficient-reserve orders explicitly', () => {
    expect(() =>
      quoteExactInput({ ...pool(), baseReserve: '0' }, 'BUY', 1n),
    ).toThrow('LIQUIDITY');
    expect(
      poolSnapshotSchema.safeParse({ ...pool(), baseReserve: '-1' }).success,
    ).toBe(false);
    expect(() => quoteExactInput(pool(), 'SELL', 1n)).toThrow('PRECISION');
    expect(() => quoteExactOutput(pool(), 'BUY', 1000000000000n)).toThrow(
      'DEPTH',
    );
    expect(quoteExactInput(pool(), 'BUY', 10n ** 25n).output).toBeLessThan(
      BigInt(pool().baseReserve),
    );
  });
});
describe('quote-to-landing and transaction cost modeling', () => {
  it('honors zero-delay quotes and rejects observations before the due time', () => {
    const c = context();
    c.quote.dueAt = t;
    c.pool = pool();
    c.nativeUsd = { ...c.nativeUsd!, observedAt: t, availableAt: t };
    expect(simulateExecution(id('immediate'), c, t).outcome).toBe('FILLED');
    c.quote.dueAt = land;
    expect(simulateExecution(id('old-pool'), c, land).outcome).toBe(
      'UNVERIFIABLE',
    );
  });
  it('applies sell minimum-output tolerance to within-limit and excessive movement', () => {
    const c = context('SELL');
    c.pool!.quoteReserve = '980000000';
    expect(simulateExecution(id('within'), c, land).outcome).toBe('FILLED');
    c.pool!.quoteReserve = '900000000';
    expect(simulateExecution(id('outside'), c, land)).toMatchObject({
      outcome: 'FAILED_ON_CHAIN',
      reason: 'SLIPPAGE_TOLERANCE_EXCEEDED',
    });
  });
  it('delivers exact net output with capped Token-2022 withholding and keeps valid reserves', () => {
    const p = pool();
    p.baseTransferFee = { bps: 125, maximumUnits: '10000000' };
    const q = quoteExactOutput(p, 'BUY', 1000000000n);
    expect(q.output).toBe(1000000000n);
    expect(q.fees.find((f) => f.category === 'TRANSFER')?.amountUnits).toBe(
      '10000000',
    );
    expect(BigInt(p.baseReserve) - BigInt(q.updatedPool.baseReserve)).toBe(
      1010000000n,
    );
    expect(
      BigInt(q.updatedPool.baseReserve) * BigInt(q.updatedPool.quoteReserve),
    ).toBeGreaterThanOrEqual(BigInt(p.baseReserve) * BigInt(p.quoteReserve));
  });
  it('rounds fractional priority lamports upward and charges tips only on successful configured routes', () => {
    const c = context();
    c.config.network.computeUnitLimit = 1;
    c.config.network.microLamportsPerCu = '1';
    expect(networkFees(c.config, land, c.nativeUsd).lamports).toBe(5001n);
    c.config.network.routeRequiresTip = true;
    c.config.network.tipLamports = '1000';
    expect(
      simulateExecution(id('tip'), c, land).fees.some(
        (f) => f.category === 'TIP',
      ),
    ).toBe(true);
    c.pool!.networkHint = 'FAILED_ON_CHAIN';
    expect(
      simulateExecution(id('no-tip'), c, land).fees.some(
        (f) => f.category === 'TIP',
      ),
    ).toBe(false);
  });
  it('rejects historical fee schedules outside their effective period', () => {
    const c = context();
    c.pool!.fees.validUntil = t;
    expect(simulateExecution(id('fee-period'), c, land).reason).toBe(
      'FEE_SCHEDULE_UNAVAILABLE',
    );
    c.config.network.validUntil = t;
    expect(simulateExecution(id('network-period'), c, land).outcome).toBe(
      'UNVERIFIABLE',
    );
  });
  it('produces repeatable seeded failures and explicit temporary network outages', () => {
    const c = context();
    c.config.failedBps = 9999;
    expect(simulateExecution(id('seed'), c, land)).toEqual(
      simulateExecution(id('seed'), c, land),
    );
    c.config.networkOutages = [{ start: t, end: '2026-01-01T00:00:02.000Z' }];
    expect(simulateExecution(id('outage'), c, land)).toMatchObject({
      outcome: 'DROPPED',
      feeUsd: '0',
    });
  });
  it('fills without generic slippage penalty or double charging fees', () => {
    const c = context(),
      a = simulateExecution(id('buy'), c, land);
    expect(a.outcome).toBe('FILLED');
    expect(a.networkFeeUsd).toBe('0.00078');
    const changed = structuredClone(c);
    changed.pool!.quoteReserve = '1200000000';
    const failed = simulateExecution(id('gap'), changed, land);
    expect(failed.outcome).toBe('FAILED_ON_CHAIN');
    expect(failed.reason).toBe('SLIPPAGE_TOLERANCE_EXCEEDED');
    expect(failed.networkFeeUsd).toBe('0.00078');
    expect(failed.updatedPool).toBeNull();
    changed.pool!.quoteReserve = '900000000';
    expect(simulateExecution(id('favorable'), changed, land).outcome).toBe(
      'FILLED',
    );
  });
  it.each(['DROPPED', 'EXPIRED', 'UNVERIFIABLE', 'FAILED_ON_CHAIN'] as const)(
    'distinguishes %s',
    (hint) => {
      const c = context();
      c.pool!.networkHint = hint;
      const a = simulateExecution(id(hint), c, land);
      expect(a.outcome).toBe(hint);
      expect(a.outputUnits).toBe('0');
      expect(a.networkFeeUsd).toBe(
        hint === 'FAILED_ON_CHAIN' ? '0.00078' : '0',
      );
      if (hint === 'UNVERIFIABLE') expect(a.retryAllowed).toBe(false);
    },
  );
  it('rejects before landing, expires old quotes and refuses missing data', () => {
    const c = context();
    expect(simulateExecution(id('early'), c, t).reason).toBe(
      'EXECUTION_BEFORE_LANDING',
    );
    expect(
      simulateExecution(id('stale'), c, '2026-01-01T00:01:00.000Z').outcome,
    ).toBe('EXPIRED');
    c.pool = null;
    expect(simulateExecution(id('missing'), c, land).outcome).toBe(
      'UNVERIFIABLE',
    );
  });
  it('requires historical native conversion and never uses a future or stale rate', () => {
    const c = context();
    c.nativeUsd = null;
    expect(simulateExecution(id('fx'), c, land)).toMatchObject({
      outcome: 'UNVERIFIABLE',
      unpricedFeeLamports: '5200',
      networkFeeUsd: '0',
    });
    c.nativeUsd = {
      priceUsd: '100',
      observedAt: '2026-01-01T00:00:02.000Z',
      availableAt: '2026-01-01T00:00:02.000Z',
      source: 'FUTURE',
    };
    expect(networkFees(c.config, land, c.nativeUsd).unknown).toBe(5200n);
  });
  it('uses requested CU limit and distinct V1 absolute fee configuration', () => {
    const c = context();
    c.config.network.computeUnitLimit = 1000000;
    expect(networkFees(c.config, land, c.nativeUsd).lamports).toBe(6000n);
    c.config.network.format = 'V1';
    c.config.network.microLamportsPerCu = '0';
    c.config.network.absolutePriorityLamports = '999';
    expect(networkFees(c.config, land, c.nativeUsd).lamports).toBe(5999n);
    c.config.network.microLamportsPerCu = '1';
    expect(executionConfigSchema.safeParse(c.config).success).toBe(false);
  });
  it('never charges a local insufficient-SOL rejection, and refuses recoverable rent rather than expensing it', () => {
    const c = context();
    c.config.network.availableLamports = '0';
    expect(simulateExecution(id('poor'), c, land)).toMatchObject({
      outcome: 'REJECTED_BEFORE_SUBMISSION',
      feeUsd: '0',
    });
    c.config.network.rentDepositLamports = '2039280';
    expect(simulateExecution(id('rent'), c, land).reason).toBe(
      'RECOVERABLE_RENT_ACCOUNTING_UNSUPPORTED',
    );
  });
  it('models liquidity removal and frozen transfers without inventing an updated pool', () => {
    for (const change of [
      { baseReserve: '0' },
      { transfers: 'FROZEN' as const },
    ]) {
      const c = context('SELL');
      Object.assign(c.pool!, change);
      expect(
        simulateExecution(id(JSON.stringify(change)), c, land),
      ).toMatchObject({
        outcome: 'FAILED_ON_CHAIN',
        outputUnits: '0',
        updatedPool: null,
      });
    }
  });
  it('keeps native and AMM fees in exactly one paper cash flow', () => {
    const c = context(),
      request = {
        orderId: id('adapter'),
        tokenMint: c.pool!.baseMint,
        side: 'BUY' as const,
        executionMode: 'PAPER' as const,
        quantity: '1',
      };
    c.pool!.fees.lpBps = 25;
    c.quote = prepareQuote(c.quote.pool, 'BUY', '1', t, t, land, c.config);
    const execution = new PaperExecutor().simulate(
      request,
      null,
      paperPolicy(backtestConfig),
      land,
      { availableCashUsd: '10', tokenBalance: '0' },
      c,
    );
    expect(execution.order.status).toBe('FILLED');
    const paid =
      toAtomic(execution.notionalUsd) + toAtomic(execution.trades[0]!.feesUsd);
    expect(fromAtomic(paid)).toBe(
      fromAtomic(
        BigInt(execution.audit!.inputUnits) * 1000000000000n +
          toAtomic(execution.audit!.networkFeeUsd),
      ),
    );
    expect(buyQuantity(pool(), '1', c.config, 9)).not.toBeNull();
  });
});
describe('full strategy/portfolio execution stress replay', () => {
  it('does not resolve conflicting same-time reserves using technical IDs', async () => {
    const file = createStressFixture(backtestConfig);
    const event = file.events.find(
      (e) =>
        e.kind === 'EXECUTION' &&
        e.data.side === 'BUY' &&
        e.eventAt === '2026-01-01T00:14:06.000Z',
    )!;
    if (event.kind !== 'EXECUTION') throw new Error('Missing fixture quote');
    const conflicting = structuredClone(event);
    conflicting.id = id('conflicting-event');
    conflicting.data.id = conflicting.id;
    conflicting.slot = null;
    conflicting.transactionIndex = null;
    conflicting.data.pool!.quoteReserve = '24800000000';
    file.events.push(conflicting);
    file.events.sort(compareHistoricalEvents);
    const setup = await backtestSetup('all', file, {
      execution: executionScenario('baseline'),
    });
    const result = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    expect(
      result.finalState.positions.find((p) => p.mint === event.mint)?.openedAt,
    ).toBe('2026-01-01T00:14:07.000Z');
  }, 30000);
  it('charges included failed buys without opening positions or reducing token basis', async () => {
    const file = createStressFixture(backtestConfig);
    for (const e of file.events)
      if (e.kind === 'EXECUTION' && e.data.side === 'BUY')
        e.data.pool!.networkHint = 'FAILED_ON_CHAIN';
    const setup = await backtestSetup('all', file, {
      execution: executionScenario('baseline'),
    });
    const result = await runBacktest(
      setup.plan,
      setup.provider,
      backtestConfig,
      setup.services,
    );
    expect(result.finalState.positions).toEqual([]);
    expect(result.metrics.execution!.outcomes.FAILED_ON_CHAIN).toBe(3);
    expect(result.finalState.availableCashUsd).toBe('99.99766');
    expect(result.finalState.realizedPnlUsd).toBe('-0.00234');
    expect(result.finalState.buyFeesUsd).toBe('0.00234');
    expect(result.finalState.investedCostBasisUsd).toBe('0');
  }, 30000);
  it.each(['missing-FX', 'ambiguous'] as const)(
    'halts %s attempts, exposes incomplete net USD and never blindly retries',
    async (kind) => {
      const file = createStressFixture(backtestConfig);
      for (const e of file.events)
        if (e.kind === 'EXECUTION') {
          if (kind === 'missing-FX') e.data.nativeUsd = null;
          else e.data.pool!.networkHint = 'UNVERIFIABLE';
        }
      const setup = await backtestSetup('all', file, {
        execution: executionScenario('baseline'),
      });
      const result = await runBacktest(
        setup.plan,
        setup.provider,
        backtestConfig,
        setup.services,
      );
      expect(result.finalState.positions).toEqual([]);
      expect(result.finalState.executionUncertain).toBe(true);
      expect(result.finalState.status).toBe('HALTED');
      expect(result.metrics.execution!.attempts).toBe(1);
      expect(result.metrics.execution!.unknownFeeLamports).toBe('5200');
      expect(result.metrics.portfolio.realizedNetPnlUsd).toBeNull();
      expect(result.metrics.portfolio.totalFeesUsd).toBeNull();
      expect(result.metrics.portfolio.endingMarkedEquityUsd).toBeNull();
    },
    30000,
  );
  it('repeats deterministically, preserves failed exits and reports unresolved exposure', async () => {
    const file = createStressFixture(backtestConfig),
      execution = executionScenario('baseline');
    const a = await backtestSetup('all', file, { execution }),
      b = await backtestSetup('all', file, { execution });
    const result = await runBacktest(
        a.plan,
        a.provider,
        backtestConfig,
        a.services,
      ),
      repeat = await runBacktest(
        b.plan,
        b.provider,
        backtestConfig,
        b.services,
      );
    expect(result).toEqual(repeat);
    expect(result.metrics.execution!.attempts).toBeGreaterThan(0);
    expect(result.metrics.trading.filledOrders).toBeGreaterThan(0);
    expect(result.metrics.execution!.failedTransactionFeesUsd).not.toBe('0');
    expect(
      result.finalState.positions.some((p) => p.status === 'EXIT_BLOCKED'),
    ).toBe(true);
    expect(result.metrics.portfolio.endingMarkedEquityUsd).toBeNull();
    const returningMint = file.manifest.markets[2]!.mint;
    expect(
      result.finalState.positions.find((p) => p.mint === returningMint)?.status,
    ).toBe('CLOSED');
    expect(result.finalState.availableCashUsd.startsWith('-')).toBe(false);
    const audits = a.store.paper.events
      .flatMap((e) => e.orders.map((o) => o.audit))
      .filter((a) => a !== undefined);
    expect(audits.some((a) => a.reason === 'SLIPPAGE_TOLERANCE_EXCEEDED')).toBe(
      true,
    );
    expect(
      audits.every(
        (a) =>
          a.context.quote.at < a.context.quote.dueAt &&
          a.executedAt >= a.context.quote.dueAt,
      ),
    ).toBe(true);
  }, 30000);
});
