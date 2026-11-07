import { describe, expect, it } from 'vitest';
import type { OrderRequest } from '@solemn/shared';
import { id, LATER, MINT, NOW } from '../../../tests/fixtures.js';
import { PaperExecutionAdapter } from '../src/execution/paper.js';
import type { SimulationFixture } from '../src/execution/paper.js';

const request: OrderRequest = {
  orderId: id(10),
  tokenMint: MINT,
  side: 'BUY',
  executionMode: 'PAPER',
  quantity: '0.3',
};
const fixture: SimulationFixture = {
  request,
  submittedAt: NOW,
  outcome: {
    status: 'FILLED',
    tradeId: id(11),
    quantity: '0.3',
    priceUsd: '0.1',
    feesUsd: '0.01',
    executedAt: LATER,
  },
};

describe('paper execution', () => {
  it('fills explicit fixtures, charges exact fees and replays idempotently', async () => {
    const adapter = new PaperExecutionAdapter('100', [fixture]);
    const results = await Promise.all([
      adapter.placeOrder(request),
      adapter.placeOrder(request),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.order.status).toBe('FILLED');
    expect(results[0]?.trades).toHaveLength(1);
    expect(adapter.getBalanceUsd()).toBe('99.96');
    expect(adapter.getHolding(MINT)).toBe('0.3');
    const result = await adapter.getOrder(request.orderId);
    result.order.status = 'FAILED';
    expect((await adapter.getOrder(request.orderId)).order.status).toBe(
      'FILLED',
    );
    await expect(adapter.cancelOrder(request.orderId)).rejects.toThrow(
      'Invalid order transition',
    );
  });
  it('requires fixtures and refuses LIVE requests at runtime', async () => {
    const adapter = new PaperExecutionAdapter('100');
    await expect(adapter.placeOrder(request)).rejects.toThrow('fixture');
    await expect(
      adapter.placeOrder({
        ...request,
        executionMode: 'LIVE',
      } as unknown as OrderRequest),
    ).rejects.toThrow();
    await expect(adapter.getOrder(request.orderId)).rejects.toThrow('Unknown');
    await expect(adapter.cancelOrder(request.orderId)).rejects.toThrow(
      'Unknown',
    );
  });
  it('rejects unrecognized fixture outcomes at runtime', () => {
    const invalid = {
      ...fixture,
      outcome: { status: 'UNKNOWN' },
    } as unknown as SimulationFixture;
    expect(() => new PaperExecutionAdapter('100', [invalid])).toThrow();
  });
  it('rejects mismatching requests and malformed fixtures', async () => {
    const adapter = new PaperExecutionAdapter('100', [fixture]);
    await expect(
      adapter.placeOrder({ ...request, quantity: '1' }),
    ).rejects.toThrow('match');
    expect(() => new PaperExecutionAdapter('100', [fixture, fixture])).toThrow(
      'Duplicate',
    );
    expect(
      () =>
        new PaperExecutionAdapter('100', [
          { ...fixture, request: { ...request, quantity: '1' } },
        ]),
    ).toThrow('quantity');
  });
  it('fails insufficient balance without changing holdings or fees', async () => {
    const adapter = new PaperExecutionAdapter('0.03', [fixture]);
    const result = await adapter.placeOrder(request);
    expect(result.order.status).toBe('FAILED');
    expect(result.failureReason).toContain('USD balance');
    expect(result.trades).toEqual([]);
    expect(adapter.getBalanceUsd()).toBe('0.03');
    expect(adapter.getHolding(MINT)).toBe('0');
  });
  it('supports exact buy then sell and rejects naked selling', async () => {
    const sellRequest: OrderRequest = {
      ...request,
      orderId: id(12),
      side: 'SELL',
    };
    const sellFixture: SimulationFixture = {
      ...fixture,
      request: sellRequest,
      outcome: {
        ...fixture.outcome,
        status: 'FILLED',
        tradeId: id(13),
        quantity: '0.3',
        priceUsd: '0.2',
        feesUsd: '0.01',
        executedAt: LATER,
      },
    };
    const adapter = new PaperExecutionAdapter('100', [fixture, sellFixture]);
    await adapter.placeOrder(request);
    await adapter.placeOrder(sellRequest);
    expect(adapter.getBalanceUsd()).toBe('100.01');
    expect(adapter.getHolding(MINT)).toBe('0');
    const empty = new PaperExecutionAdapter('100', [sellFixture]);
    expect((await empty.placeOrder(sellRequest)).failureReason).toContain(
      'holdings',
    );
    expect(empty.getBalanceUsd()).toBe('100');
  });
  it('cancels submitted orders idempotently', async () => {
    const adapter = new PaperExecutionAdapter('100', [
      { ...fixture, outcome: { status: 'SUBMITTED' } },
    ]);
    expect((await adapter.placeOrder(request)).order.status).toBe('SUBMITTED');
    expect((await adapter.cancelOrder(request.orderId)).order.status).toBe(
      'CANCELLED',
    );
    expect((await adapter.cancelOrder(request.orderId)).cancelled).toBe(true);
    expect(adapter.getBalanceUsd()).toBe('100');
  });
  it('retains partial fills when cancelling the remainder', async () => {
    const partial: SimulationFixture = {
      ...fixture,
      outcome: {
        status: 'PARTIALLY_FILLED',
        tradeId: id(14),
        quantity: '0.1',
        priceUsd: '0.1',
        feesUsd: '0.01',
        executedAt: LATER,
      },
    };
    const adapter = new PaperExecutionAdapter('100', [partial]);
    expect((await adapter.placeOrder(request)).order.status).toBe(
      'PARTIALLY_FILLED',
    );
    await adapter.cancelOrder(request.orderId);
    expect((await adapter.getOrder(request.orderId)).trades).toHaveLength(1);
    expect(adapter.getBalanceUsd()).toBe('99.98');
    expect(adapter.getHolding(MINT)).toBe('0.1');
  });
  it('supports fixture failures with no fills', async () => {
    const adapter = new PaperExecutionAdapter('100', [
      {
        ...fixture,
        outcome: { status: 'FAILED', reason: 'Fixture rejection' },
      },
    ]);
    expect((await adapter.placeOrder(request)).failureReason).toBe(
      'Fixture rejection',
    );
    expect(adapter.getBalanceUsd()).toBe('100');
  });
});
