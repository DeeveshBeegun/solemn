import {
  addDecimal,
  assertOrderTransition,
  decimalSchema,
  fromAtomic,
  multiplyDecimal,
  orderRequestSchema,
  positiveDecimalSchema,
  timestampSchema,
  toAtomic,
  idSchema,
} from '@solemn/shared';
import type { OrderRequest, OrderStatus, Trade } from '@solemn/shared';
import { z } from 'zod';
import type { CancelResult, ExecutionAdapter, OrderResult } from './adapter.js';

export const simulationFixtureSchema = z.strictObject({
  request: orderRequestSchema,
  submittedAt: timestampSchema,
  outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('SUBMITTED') }),
    z.strictObject({
      status: z.literal('FAILED'),
      reason: z.string().min(1).max(256),
    }),
    z.strictObject({
      status: z.enum(['FILLED', 'PARTIALLY_FILLED']),
      tradeId: idSchema,
      quantity: positiveDecimalSchema,
      priceUsd: positiveDecimalSchema,
      feesUsd: decimalSchema,
      executedAt: timestampSchema,
    }),
  ]),
});

export type SimulationFixture = z.infer<typeof simulationFixtureSchema>;

/** In-memory fixture runner only. No pricing, market access, signing or persistence. */
export class PaperExecutionAdapter implements ExecutionAdapter {
  private readonly fixtures = new Map<string, SimulationFixture>();
  private readonly results = new Map<string, OrderResult>();
  private balance: bigint;
  private readonly holdings = new Map<string, bigint>();

  constructor(
    initialBalanceUsd: string,
    fixtures: readonly SimulationFixture[] = [],
  ) {
    this.balance = toAtomic(decimalSchema.parse(initialBalanceUsd));
    const tradeIds = new Set<string>();
    for (const input of fixtures) {
      const fixture = simulationFixtureSchema.parse(input);
      if (this.fixtures.has(fixture.request.orderId))
        throw new Error('Duplicate fixture order ID');
      if (
        fixture.outcome.status === 'FILLED' ||
        fixture.outcome.status === 'PARTIALLY_FILLED'
      ) {
        const fill = fixture.outcome;
        if (Date.parse(fill.executedAt) < Date.parse(fixture.submittedAt))
          throw new Error('Fill precedes submission');
        const requested = toAtomic(fixture.request.quantity);
        const filled = toAtomic(fill.quantity);
        if (
          filled > requested ||
          (fill.status === 'FILLED'
            ? filled !== requested
            : filled === requested)
        ) {
          throw new Error('Fixture fill quantity does not match its lifecycle');
        }
        if (tradeIds.has(fill.tradeId))
          throw new Error('Duplicate fixture trade ID');
        tradeIds.add(fill.tradeId);
        // Validate precision before any order or balance can be mutated.
        multiplyDecimal(fill.quantity, fill.priceUsd);
      }
      this.fixtures.set(fixture.request.orderId, fixture);
    }
  }

  getBalanceUsd(): string {
    return fromAtomic(this.balance);
  }
  getHolding(tokenMint: string): string {
    return fromAtomic(this.holdings.get(tokenMint) ?? 0n);
  }

  async placeOrder(input: OrderRequest): Promise<OrderResult> {
    const request = orderRequestSchema.parse(input);
    const fixture = this.fixtures.get(request.orderId);
    if (!fixture)
      throw new Error(
        'Unsupported order: an explicit simulation fixture is required',
      );
    const expected = fixture.request;
    if (
      request.tokenMint !== expected.tokenMint ||
      request.side !== expected.side ||
      toAtomic(request.quantity) !== toAtomic(expected.quantity)
    ) {
      throw new Error('Order does not match its simulation fixture');
    }
    const existing = this.results.get(request.orderId);
    if (existing) return structuredClone(existing);

    const result: OrderResult = {
      order: {
        id: request.orderId,
        tokenMint: request.tokenMint,
        side: request.side,
        executionMode: 'PAPER',
        requestedQuantity: request.quantity,
        status: 'CREATED',
        createdAt: fixture.submittedAt,
        submittedAt: null,
        executedAt: null,
        estimatedFeesUsd: '0',
        actualFeesUsd: null,
      },
      trades: [],
      failureReason: null,
    };
    const transition = (status: OrderStatus) => {
      assertOrderTransition(result.order.status, status);
      result.order.status = status;
    };
    transition('SUBMITTED');
    result.order.submittedAt = fixture.submittedAt;
    const outcome = fixture.outcome;
    if (outcome.status === 'FAILED') {
      transition('FAILED');
      result.failureReason = outcome.reason;
    } else if (outcome.status !== 'SUBMITTED') {
      const value = toAtomic(
        multiplyDecimal(outcome.quantity, outcome.priceUsd),
      );
      const fees = toAtomic(outcome.feesUsd);
      const quantity = toAtomic(outcome.quantity);
      const held = this.holdings.get(request.tokenMint) ?? 0n;
      const nextBalance =
        request.side === 'BUY'
          ? this.balance - value - fees
          : this.balance + value - fees;
      const nextHolding =
        request.side === 'BUY' ? held + quantity : held - quantity;
      if (nextBalance < 0n || nextHolding < 0n) {
        transition('FAILED');
        result.failureReason =
          nextHolding < 0n
            ? 'Insufficient simulated token holdings'
            : 'Insufficient simulated USD balance';
      } else {
        decimalSchema.parse(fromAtomic(nextBalance));
        decimalSchema.parse(fromAtomic(nextHolding));
        const trade: Trade = {
          id: outcome.tradeId,
          orderId: request.orderId,
          tokenMint: request.tokenMint,
          side: request.side,
          executedQuantity: outcome.quantity,
          executionPriceUsd: outcome.priceUsd,
          feesUsd: outcome.feesUsd,
          timestamp: outcome.executedAt,
        };
        // Validated exact values; no await between checks and mutation.
        result.order.estimatedFeesUsd = addDecimal('0', outcome.feesUsd);
        result.order.actualFeesUsd = outcome.feesUsd;
        result.order.executedAt = outcome.executedAt;
        result.trades.push(trade);
        this.balance = nextBalance;
        this.holdings.set(request.tokenMint, nextHolding);
        transition(outcome.status);
      }
    }
    this.results.set(request.orderId, result);
    return structuredClone(result);
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    const result = this.results.get(orderId);
    if (!result) throw new Error('Unknown simulated order');
    return structuredClone(result);
  }

  async cancelOrder(orderId: string): Promise<CancelResult> {
    const result = this.results.get(orderId);
    if (!result) throw new Error('Unknown simulated order');
    if (result.order.status === 'CANCELLED')
      return { order: structuredClone(result.order), cancelled: true };
    assertOrderTransition(result.order.status, 'CANCELLED');
    result.order.status = 'CANCELLED';
    return { order: structuredClone(result.order), cancelled: true };
  }
}
