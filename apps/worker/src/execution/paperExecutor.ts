import {
  assertOrderTransition,
  executionObservationSchema,
  fromAtomic,
  orderRequestSchema,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type {
  ExecutionObservation,
  OrderRequest,
  OrderStatus,
  PaperPolicy,
} from '@solemn/shared';
import type { OrderResult } from './adapter.js';
import {
  ceilDivide,
  feeFor,
  HUNDRED,
  moneyNotional,
  quantityStep,
} from '../portfolio/decimal.js';

export function observationProblem(
  observation: ExecutionObservation | null,
  policy: PaperPolicy,
  at: string,
  mint?: string,
  pool?: string,
  side?: 'BUY' | 'SELL',
): string | null {
  if (
    !observation ||
    observation.priceUsd === null ||
    !observation.usdReliable ||
    observation.usdSource === null ||
    !observation.healthy
  )
    return 'MARKET_DATA_UNAVAILABLE';
  if (
    (mint && observation.mint !== mint) ||
    (pool && observation.poolAddress !== pool) ||
    (side && observation.side !== side)
  )
    return 'INCOMPATIBLE_EXECUTION_OBSERVATION';
  if (
    Date.parse(observation.receivedAt) > Date.parse(at) ||
    Date.parse(observation.observedAt) > Date.parse(at)
  )
    return 'OBSERVATION_IN_FUTURE';
  if (
    Date.parse(at) - Date.parse(observation.observedAt) >
    policy.maxPriceAgeSeconds * 1000
  )
    return 'EXECUTION_OBSERVATION_STALE';
  return null;
}
export function executionPrice(
  observation: ExecutionObservation,
  policy: PaperPolicy,
): string | null {
  if (!observation.priceUsd) return null;
  const total =
    toAtomic(policy.slippagePercent) +
    toAtomic(observation.estimatedPriceImpactPercent ?? '0');
  if (total >= HUNDRED) return null;
  const product =
    toAtomic(observation.priceUsd) *
    (observation.side === 'BUY' ? HUNDRED + total : HUNDRED - total);
  const price =
    observation.side === 'BUY'
      ? ceilDivide(product, HUNDRED)
      : product / HUNDRED;
  return price > 0n ? fromAtomic(price) : null;
}
export interface PaperExecutionResult extends OrderResult {
  notionalUsd: string;
  slippageUsd: string;
  lifecycle: OrderStatus[];
}
/** Stateless explicit-observation fill model; durable idempotency/accounting belong to the portfolio transaction. */
export class PaperExecutor {
  simulate(
    input: OrderRequest,
    observation: ExecutionObservation | null,
    policy: PaperPolicy,
    at: string,
    resources: { availableCashUsd: string; tokenBalance: string },
  ): PaperExecutionResult {
    const request = orderRequestSchema.parse(input);
    if (observation) executionObservationSchema.parse(observation);
    const result: PaperExecutionResult = {
      order: {
        id: request.orderId,
        tokenMint: request.tokenMint,
        side: request.side,
        executionMode: 'PAPER',
        requestedQuantity: request.quantity,
        status: 'CREATED',
        createdAt: at,
        submittedAt: null,
        executedAt: null,
        estimatedFeesUsd: '0',
        actualFeesUsd: null,
      },
      trades: [],
      failureReason: null,
      notionalUsd: '0',
      slippageUsd: '0',
      lifecycle: ['CREATED'],
    };
    const move = (status: OrderStatus) => {
      assertOrderTransition(result.order.status, status);
      result.order.status = status;
      result.lifecycle.push(status);
    };
    move('SUBMITTED');
    result.order.submittedAt = at;
    const fail = (reason: string) => {
      move('FAILED');
      result.failureReason = reason;
      return result;
    };
    const problem = observationProblem(
      observation,
      policy,
      at,
      request.tokenMint,
      undefined,
      request.side,
    );
    if (problem) return fail(problem);
    const quote = observation as ExecutionObservation;
    const price = executionPrice(quote, policy);
    if (price === null) return fail('INVALID_EXECUTION_PRICE');
    if (
      toAtomic(request.quantity) % quantityStep(policy.quantityDecimals) !==
      0n
    )
      return fail('INVALID_QUANTITY_PRECISION');
    if (quote.liquidityUsd === null || toAtomic(quote.liquidityUsd) <= 0n)
      return fail('LIQUIDITY_UNAVAILABLE');
    const notional = moneyNotional(request.quantity, price, request.side),
      fees = feeFor(
        notional,
        request.side === 'BUY' ? policy.buyFeePercent : policy.sellFeePercent,
      );
    if (notional <= 0n) return fail('ORDER_NOTIONAL_BELOW_PRECISION');
    result.order.estimatedFeesUsd = fromAtomic(fees);
    if (
      notional * HUNDRED >
      toAtomic(quote.liquidityUsd) *
        toAtomic(policy.maxLiquidityParticipationPercent)
    )
      return fail('LIQUIDITY_PARTICIPATION_EXCEEDED');
    if (request.side === 'BUY' && notional < toAtomic(policy.minimumOrderUsd))
      return fail('ORDER_BELOW_MINIMUM');
    if (
      request.side === 'BUY' &&
      notional + fees > toAtomic(resources.availableCashUsd)
    )
      return fail('INSUFFICIENT_CASH');
    if (
      request.side === 'SELL' &&
      toAtomic(request.quantity) > toAtomic(resources.tokenBalance)
    )
      return fail('INSUFFICIENT_TOKENS');
    if (request.side === 'SELL' && fees > notional)
      return fail('FEES_EXCEED_PROCEEDS');
    if (quote.simulationOutcome === 'PARTIAL_FILL')
      return fail('PARTIAL_EXECUTION_UNSUPPORTED');
    if (quote.simulationOutcome === 'TRANSACTION_FAILURE')
      return fail('SIMULATED_TRANSACTION_FAILURE');
    result.notionalUsd = fromAtomic(notional);
    const referenceNotional = moneyNotional(
      request.quantity,
      quote.priceUsd as string,
      request.side,
    );
    result.slippageUsd = fromAtomic(
      request.side === 'BUY'
        ? notional - referenceNotional
        : referenceNotional - notional,
    );
    result.trades.push({
      id: stableId(['paper-fill-v1', request.orderId]),
      orderId: request.orderId,
      tokenMint: request.tokenMint,
      side: request.side,
      executedQuantity: request.quantity,
      executionPriceUsd: price,
      feesUsd: fromAtomic(fees),
      timestamp: at,
    });
    result.order.actualFeesUsd = fromAtomic(fees);
    result.order.executedAt = at;
    move('FILLED');
    return result;
  }
}
