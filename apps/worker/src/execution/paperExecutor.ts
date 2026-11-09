import { simulateExecution } from './simulation/executionSimulator.js';
import { decimalUnits, scale } from './simulation/poolModels.js';
import { networkFees } from './simulation/feeModel.js';
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
  ExecutionContext,
  ExecutionAudit,
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
  audit?: ExecutionAudit;
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
    context?: ExecutionContext,
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
    if (context) {
      const audit = simulateExecution(request.orderId, context, at);
      result.audit = audit;
      const localReject = (reason: string) => {
        audit.outcome = 'REJECTED_BEFORE_SUBMISSION';
        audit.reason = reason;
        audit.fees = [];
        audit.feeUsd = '0';
        audit.networkFeeUsd = '0';
        audit.includedFeeUsd = '0';
        audit.unpricedFeeLamports = '0';
        audit.inputUnits = '0';
        audit.outputUnits = '0';
        audit.updatedPool = null;
        result.order.actualFeesUsd = '0';
        return fail(reason);
      };
      if (
        context.quote.side !== request.side ||
        context.quote.quantity !== request.quantity ||
        (context.pool && context.pool.baseMint !== request.tokenMint)
      )
        return localReject('EXECUTION_REQUEST_MISMATCH');
      if (
        toAtomic(request.quantity) % quantityStep(policy.quantityDecimals) !==
        0n
      )
        return localReject('INVALID_QUANTITY_PRECISION');
      let network;
      try {
        network = networkFees(context.config, at, context.nativeUsd);
      } catch {
        network = null;
      }
      const tipUsd =
        context.config.network.routeRequiresTip &&
        network?.rate !== null &&
        network?.rate !== undefined
          ? ceilDivide(
              BigInt(context.config.network.tipLamports) * network.rate,
              1000000000n,
            )
          : 0n;
      const maxBuy = context.quote.pool?.quoteUsd
        ? (BigInt(context.quote.limitUnits) *
            toAtomic(context.quote.pool.quoteUsd) +
            scale(context.quote.pool.quoteDecimals) -
            1n) /
            scale(context.quote.pool.quoteDecimals) +
          (network?.usd ?? 0n) +
          tipUsd
        : 0n;
      if (
        request.side === 'BUY' &&
        maxBuy > toAtomic(resources.availableCashUsd)
      )
        return localReject('INSUFFICIENT_CASH');
      if ((network?.usd ?? 0n) + tipUsd > toAtomic(resources.availableCashUsd))
        return localReject('INSUFFICIENT_CASH_FOR_NETWORK_FEES');
      if (
        request.side === 'SELL' &&
        toAtomic(request.quantity) > toAtomic(resources.tokenBalance)
      )
        return localReject('INSUFFICIENT_TOKENS');
      result.order.estimatedFeesUsd = audit.feeUsd;
      result.order.actualFeesUsd = audit.feeUsd;
      if (audit.outcome !== 'FILLED')
        return fail(audit.reason ?? audit.outcome);
      const pool = context.pool!,
        quoteUnits = BigInt(
          request.side === 'BUY' ? audit.inputUnits : audit.outputUnits,
        );
      const grossUsd =
        request.side === 'BUY'
          ? ceilDivide(
              quoteUnits * toAtomic(pool.quoteUsd!),
              scale(pool.quoteDecimals),
            )
          : (quoteUnits * toAtomic(pool.quoteUsd!)) / scale(pool.quoteDecimals);
      if (request.side === 'BUY' && grossUsd < toAtomic(policy.minimumOrderUsd))
        return localReject('ORDER_BELOW_MINIMUM');
      if (
        request.side === 'BUY' &&
        grossUsd + toAtomic(audit.networkFeeUsd) >
          toAtomic(resources.availableCashUsd)
      )
        return localReject('INSUFFICIENT_CASH_AT_EXECUTION_FX');
      const included = toAtomic(audit.includedFeeUsd),
        fees = toAtomic(audit.feeUsd);
      const notional =
        request.side === 'BUY' ? grossUsd - included : grossUsd + included;
      if (notional <= 0n) return localReject('NOTIONAL_BELOW_PRECISION');
      // Venue/transfer fees are in the AMM cash flow. Split them out for the existing ledger exactly once.
      result.notionalUsd = fromAtomic(notional);
      const price = fromAtomic(
        (notional * scale(18)) / toAtomic(request.quantity),
      );
      if (toAtomic(price) <= 0n)
        return localReject('EXECUTION_PRICE_BELOW_PRECISION');
      decimalUnits(request.quantity, pool.baseDecimals);
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
      result.order.executedAt = at;
      move('FILLED');
      return result;
    }
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
