import { describe, expect, it } from 'vitest';
import { fromAtomic, stableId, toAtomic } from '@solemn/shared';
import {
  PaperExecutor,
  executionPrice,
} from '../src/execution/paperExecutor.js';
import { paperPolicy } from '../src/portfolio/policy.js';
import { sizePosition } from '../src/risk/positionSizing.js';
import { createPaperReplayFixture } from '../src/portfolio/replayFixture.js';
import { paperConfig } from './paperFixtures.js';
import { replayTime } from '../src/strategy/replayFixture.js';
const policy = paperPolicy(paperConfig),
  quote = createPaperReplayFixture(paperConfig).observations[0]!;
const request = {
  orderId: stableId(['executor-unit']),
  tokenMint: quote.mint,
  executionMode: 'PAPER' as const,
  side: 'BUY' as const,
  quantity: '0.001',
};
const resources = { availableCashUsd: '100', tokenBalance: '1' };
describe('observation-driven paper execution', () => {
  it('models buy/sell prices, separate fees and terminal lifecycle from explicit observations', () => {
    const buy = new PaperExecutor().simulate(
      request,
      quote,
      policy,
      quote.receivedAt,
      resources,
    );
    expect(buy.order.status).toBe('FILLED');
    expect(buy.lifecycle).toEqual(['CREATED', 'SUBMITTED', 'FILLED']);
    expect(buy.trades[0]).toMatchObject({
      executionPriceUsd: '125.24',
      feesUsd: '0.0012524',
    });
    const sell = new PaperExecutor().simulate(
      { ...request, side: 'SELL' },
      { ...quote, side: 'SELL' },
      policy,
      quote.receivedAt,
      resources,
    );
    expect(sell.trades[0]).toMatchObject({
      executionPriceUsd: '122.76',
      feesUsd: '0.0012276',
    });
    expect(buy.slippageUsd).toBe('0.00124');
    expect(sell.slippageUsd).toBe('0.00124');
    expect(
      new PaperExecutor().simulate(
        request,
        quote,
        policy,
        quote.receivedAt,
        resources,
      ),
    ).toEqual(buy);
  });
  it.each([
    'missing',
    'price',
    'usd',
    'stale',
    'future',
    'liquidity',
    'participation',
    'cash',
    'failure',
    'partial',
    'quantity',
  ] as const)('fails closed for %s', (mode) => {
    const observation = structuredClone(quote),
      balance = { ...resources },
      order = { ...request };
    let at = quote.receivedAt;
    if (mode === 'price') observation.priceUsd = null;
    if (mode === 'usd') observation.usdReliable = false;
    if (mode === 'stale') at = replayTime(15);
    if (mode === 'future') at = replayTime(13);
    if (mode === 'liquidity') observation.liquidityUsd = '0';
    if (mode === 'participation') observation.liquidityUsd = '1';
    if (mode === 'cash') balance.availableCashUsd = '0';
    if (mode === 'failure')
      observation.simulationOutcome = 'TRANSACTION_FAILURE';
    if (mode === 'partial') observation.simulationOutcome = 'PARTIAL_FILL';
    if (mode === 'quantity') order.quantity = '0.0000000001';
    const result = new PaperExecutor().simulate(
      order,
      mode === 'missing' ? null : observation,
      policy,
      at,
      balance,
    );
    expect(result.order.status).toBe('FAILED');
    expect(result.trades).toHaveLength(0);
    expect(result.order.executedAt).toBeNull();
    expect(result.failureReason).not.toBeNull();
  });
  it('rejects insufficient holdings, invalid prices and real execution requests', () => {
    const executor = new PaperExecutor();
    expect(
      executor.simulate(
        { ...request, side: 'SELL' },
        { ...quote, side: 'SELL' },
        policy,
        quote.receivedAt,
        { ...resources, tokenBalance: '0' },
      ).failureReason,
    ).toBe('INSUFFICIENT_TOKENS');
    expect(() =>
      executor.simulate(
        request,
        { ...quote, priceUsd: '0' },
        policy,
        quote.receivedAt,
        resources,
      ),
    ).toThrow();
    expect(() =>
      executor.simulate(
        { ...request, executionMode: 'LIVE' } as unknown as typeof request,
        quote,
        policy,
        quote.receivedAt,
        resources,
      ),
    ).toThrow();
  });
});
describe('fee-aware allocation sizing', () => {
  it('limits all-in position cost to 1% and never rounds quantity upward', () => {
    const size = sizePosition(
      '100',
      '100',
      executionPrice(quote, policy)!,
      policy,
    )!;
    expect(size.budgetUsd).toBe('1');
    expect(toAtomic(size.totalCostUsd)).toBeLessThanOrEqual(toAtomic('1'));
    const higherFee = sizePosition(
      '100',
      '100',
      executionPrice(quote, policy)!,
      { ...policy, buyFeePercent: '2' },
    )!;
    expect(toAtomic(higherFee.quantity)).toBeLessThan(toAtomic(size.quantity));
    expect(sizePosition('100', '0.001', '100', policy)).toBeNull();
  });
  it('obeys cash and budget invariants over precision-sensitive quantities and prices', () => {
    for (const price of [
      '0.000000001',
      '0.1',
      '3.141592653589793238',
      '124',
      '9007199254740993',
    ]) {
      for (const cash of ['0', '0.01', '0.999999999999999999', '100']) {
        const result = sizePosition('100', cash, price, policy);
        if (!result) continue;
        const q = toAtomic(result.quantity),
          p = toAtomic(price),
          scale = 10n ** 18n;
        const notional = (q * p + scale - 1n) / scale;
        const fee =
          (notional * toAtomic(policy.buyFeePercent) + 100n * scale - 1n) /
          (100n * scale);
        expect(result.totalCostUsd).toBe(fromAtomic(notional + fee));
        expect(notional + fee).toBeLessThanOrEqual(toAtomic(cash));
        expect(notional + fee).toBeLessThanOrEqual(toAtomic('1'));
        expect(q % 1000000000n).toBe(0n);
      }
    }
  });
});
