import {
  executionContextSchema,
  fromAtomic,
  stableHash,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type {
  ExecutionAudit,
  ExecutionConfig,
  ExecutionContext,
  PoolSnapshot,
  PreparedQuote,
} from '@solemn/shared';
import {
  ceil,
  decimalUnits,
  quoteExactInput,
  quoteExactOutput,
  scale,
  unitsDecimal,
} from './poolModels.js';
import { networkFees } from './feeModel.js';
export const latencyMs = (config: ExecutionConfig) =>
  Object.values(config.latency).reduce((sum, n) => sum + n, 0);
export function scenarioPool(
  pool: PoolSnapshot,
  config: ExecutionConfig,
): PoolSnapshot {
  return config.scenario === 'idealized'
    ? {
        ...pool,
        fees: {
          ...pool.fees,
          lpBps: 0,
          protocolBps: 0,
          creatorBps: 0,
          routingBps: 0,
          integratorBps: 0,
        },
      }
    : pool;
}
export function prepareQuote(
  pool: PoolSnapshot | null,
  side: 'BUY' | 'SELL',
  quantity: string,
  triggerAt: string,
  at: string,
  dueAt: string,
  config: ExecutionConfig,
): PreparedQuote {
  const quote: PreparedQuote = {
    pool,
    side,
    quantity,
    triggerAt,
    at,
    dueAt,
    inputUnits: '0',
    outputUnits: '0',
    limitUnits: '0',
    error: null,
  };
  try {
    if (
      !pool ||
      pool.availableAt > at ||
      Date.parse(at) - Date.parse(pool.observedAt) > config.maxQuoteAgeMs
    )
      throw new Error('QUOTE_POOL_UNAVAILABLE');
    const p = scenarioPool(pool, config),
      amount = decimalUnits(quantity, p.baseDecimals);
    const q =
      side === 'BUY'
        ? quoteExactOutput(p, side, amount)
        : quoteExactInput(p, side, amount);
    quote.inputUnits = q.input.toString();
    quote.outputUnits = q.output.toString();
    quote.limitUnits = (
      side === 'BUY'
        ? ceil(q.input * BigInt(10000 + config.maxSlippageBps), 10000n)
        : (q.output * BigInt(10000 - config.maxSlippageBps)) / 10000n
    ).toString();
  } catch (e) {
    quote.error = e instanceof Error ? e.message : 'QUOTE_UNVERIFIABLE';
  }
  return quote;
}
export function buyQuantity(
  pool: PoolSnapshot | null,
  budgetUsd: string,
  config: ExecutionConfig,
  quantityDecimals: number,
): string | null {
  if (!pool?.quoteUsd) return null;
  try {
    // Leave tolerance and network-cost headroom. Budget includes all costs, rechecked at settlement.
    const budget =
      (toAtomic(budgetUsd) * 9500n) / BigInt(10000 + config.maxSlippageBps);
    const input =
      (budget * scale(pool.quoteDecimals)) / toAtomic(pool.quoteUsd);
    const q = quoteExactInput(scenarioPool(pool, config), 'BUY', input);
    const decimal = toAtomic(unitsDecimal(q.output, pool.baseDecimals)),
      quantum = scale(18 - Math.min(quantityDecimals, pool.baseDecimals));
    const qty = (decimal / quantum) * quantum;
    return qty > 0n ? fromAtomic(qty) : null;
  } catch {
    return null;
  }
}
export function simulateExecution(
  orderId: string,
  contextInput: ExecutionContext,
  at: string,
): ExecutionAudit {
  const context = executionContextSchema.parse(contextInput),
    { config, quote, pool } = context;
  const audit: ExecutionAudit = {
    id: stableId(['execution-attempt-v1', orderId]),
    runId: context.runId,
    orderId,
    modelVersion: config.modelVersion,
    context,
    executedAt: at,
    outcome: 'REJECTED_BEFORE_SUBMISSION',
    reason: null,
    retryAllowed: true,
    inputAsset:
      quote.side === 'BUY'
        ? (pool?.quoteMint ?? 'UNKNOWN')
        : (pool?.baseMint ?? 'UNKNOWN'),
    outputAsset:
      quote.side === 'BUY'
        ? (pool?.baseMint ?? 'UNKNOWN')
        : (pool?.quoteMint ?? 'UNKNOWN'),
    inputUnits: '0',
    outputUnits: '0',
    quotedInputUnits: quote.inputUnits,
    quotedOutputUnits: quote.outputUnits,
    effectivePriceUsd: null,
    impactBps: null,
    latencyMs: Math.max(0, Date.parse(at) - Date.parse(quote.triggerAt)),
    fees: [],
    feeUsd: '0',
    includedFeeUsd: '0',
    networkFeeUsd: '0',
    unpricedFeeLamports: '0',
    updatedPool: null,
  };
  const fail = (
    reason: string,
    outcome: ExecutionAudit['outcome'] = 'REJECTED_BEFORE_SUBMISSION',
  ) => {
    audit.reason = reason;
    audit.outcome = outcome;
    audit.retryAllowed = outcome !== 'UNVERIFIABLE';
    return audit;
  };
  if (quote.error) return fail(quote.error);
  if (at < quote.dueAt || at < quote.at)
    return fail('EXECUTION_BEFORE_LANDING');
  if (Date.parse(at) - Date.parse(quote.at) > config.maxQuoteAgeMs)
    return fail('STALE_QUOTE', 'EXPIRED');
  if (
    !pool ||
    pool.availableAt > at ||
    pool.observedAt < quote.dueAt ||
    Date.parse(at) - Date.parse(pool.observedAt) > config.maxQuoteAgeMs
  )
    return fail('EXECUTION_POOL_UNAVAILABLE', 'UNVERIFIABLE');
  if (
    !quote.pool ||
    pool.poolAddress !== quote.pool.poolAddress ||
    pool.baseMint !== quote.pool.baseMint ||
    pool.quoteMint !== quote.pool.quoteMint ||
    pool.baseDecimals !== quote.pool.baseDecimals ||
    pool.quoteDecimals !== quote.pool.quoteDecimals
  )
    return fail('POOL_IDENTITY_MISMATCH');
  if (config.network.rentDepositLamports !== '0')
    return fail('RECOVERABLE_RENT_ACCOUNTING_UNSUPPORTED');
  let network;
  try {
    network = networkFees(config, at, context.nativeUsd);
  } catch {
    return fail('NETWORK_FEE_SCHEDULE_UNAVAILABLE', 'UNVERIFIABLE');
  }
  if (
    network.lamports + BigInt(config.network.tipLamports) >
    BigInt(config.network.availableLamports)
  )
    return fail('INSUFFICIENT_SOL_FOR_FEES');
  const draw = Number(
    BigInt('0x' + stableHash([config.seed, context.randomKey]).slice(0, 12)) %
      10000n,
  );
  let hint = pool.networkHint;
  if (config.networkOutages?.some((o) => at >= o.start && at < o.end))
    hint = 'DROPPED';
  if (hint === 'NORMAL') {
    if (draw < config.ambiguousBps) hint = 'UNVERIFIABLE';
    else if (draw < config.ambiguousBps + config.droppedBps) hint = 'DROPPED';
    else if (draw < config.ambiguousBps + config.droppedBps + config.failedBps)
      hint = 'FAILED_ON_CHAIN';
  }
  if (hint === 'DROPPED' || hint === 'EXPIRED')
    return fail('MODELED_' + hint, hint);
  if (hint === 'UNVERIFIABLE') {
    audit.unpricedFeeLamports = network.lamports.toString();
    return fail('AMBIGUOUS_LANDING', 'UNVERIFIABLE');
  }
  // Included attempts pay validator fees even when swap execution rolls back.
  audit.fees = network.fees;
  audit.networkFeeUsd = fromAtomic(network.usd);
  audit.feeUsd = audit.networkFeeUsd;
  audit.unpricedFeeLamports = network.unknown.toString();
  if (
    config.network.routeRequiresTip &&
    config.network.tipLamports !== '0' &&
    network.rate === null
  ) {
    audit.unpricedFeeLamports = (
      network.lamports + BigInt(config.network.tipLamports)
    ).toString();
    return fail('HISTORICAL_SOL_USD_UNAVAILABLE', 'UNVERIFIABLE');
  }
  if (network.unknown)
    return fail('HISTORICAL_SOL_USD_UNAVAILABLE', 'UNVERIFIABLE');
  if (hint === 'FAILED_ON_CHAIN')
    return fail('MODELED_COMPUTE_OR_NETWORK_FAILURE', 'FAILED_ON_CHAIN');
  try {
    const p = scenarioPool(pool, config),
      amount = decimalUnits(quote.quantity, p.baseDecimals);
    const q =
      quote.side === 'BUY'
        ? quoteExactOutput(p, 'BUY', amount)
        : quoteExactInput(p, 'SELL', amount);
    if (
      quote.side === 'BUY'
        ? q.input > BigInt(quote.limitUnits)
        : q.output < BigInt(quote.limitUnits)
    )
      return fail('SLIPPAGE_TOLERANCE_EXCEEDED', 'FAILED_ON_CHAIN');
    if (config.network.routeRequiresTip && config.network.tipLamports !== '0') {
      const tip = BigInt(config.network.tipLamports),
        price = network.rate!,
        usd = ceil(tip * price, 1000000000n);
      audit.fees.push({
        category: 'TIP',
        asset: 'SOL',
        amountUnits: tip.toString(),
        decimals: 9,
        usd: fromAtomic(usd),
        includedInQuote: false,
      });
      audit.networkFeeUsd = fromAtomic(network.usd + usd);
    }
    audit.outcome = 'FILLED';
    audit.inputUnits = q.input.toString();
    audit.outputUnits = q.output.toString();
    audit.effectivePriceUsd = q.effectivePriceUsd;
    audit.impactBps = q.impactBps;
    audit.updatedPool = q.updatedPool;
    audit.fees.push(...q.fees);
    audit.includedFeeUsd = fromAtomic(q.includedFeeUsd);
    audit.feeUsd = fromAtomic(q.includedFeeUsd + toAtomic(audit.networkFeeUsd));
    return audit;
  } catch (e) {
    return fail(
      e instanceof Error ? e.message : 'POOL_UNVERIFIABLE',
      'FAILED_ON_CHAIN',
    );
  }
}
