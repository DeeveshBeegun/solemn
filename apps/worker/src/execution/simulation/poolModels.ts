import {
  fromAtomic,
  poolSnapshotSchema,
  stableId,
  toAtomic,
} from '@solemn/shared';
import type { FeeComponent, PoolSnapshot } from '@solemn/shared';
const BPS = 10000n;
export const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export const scale = (decimals: number) => 10n ** BigInt(decimals);
export function decimalUnits(value: string, decimals: number): bigint {
  const n = toAtomic(value),
    divisor = scale(18 - decimals);
  if (n % divisor) throw new Error('INVALID_TOKEN_PRECISION');
  return n / divisor;
}
export const unitsDecimal = (value: bigint, decimals: number) =>
  fromAtomic(value * scale(18 - decimals));
export interface PoolQuote {
  input: bigint;
  output: bigint;
  grossOutput: bigint;
  effectivePriceUsd: string;
  marginalBeforeUsd: string;
  marginalAfterUsd: string;
  impactBps: string;
  fees: FeeComponent[];
  includedFeeUsd: bigint;
  updatedPool: PoolSnapshot;
}
export interface LiquidityPoolModel {
  exactInput(
    pool: PoolSnapshot,
    side: 'BUY' | 'SELL',
    input: bigint,
  ): PoolQuote;
}
const models = new Map<string, LiquidityPoolModel>();
export function registerPoolModel(id: string, model: LiquidityPoolModel): void {
  if (models.has(id)) throw new Error('Pool model already registered');
  models.set(id, model);
}
export function validatePool(pool: PoolSnapshot): void {
  poolSnapshotSchema.parse(pool);
  if (!models.has(pool.model)) throw new Error('UNSUPPORTED_POOL_MODEL');
  if (pool.quality === 'UNKNOWN') throw new Error('UNVERIFIABLE_POOL');
  if (BigInt(pool.baseReserve) <= 0n || BigInt(pool.quoteReserve) <= 0n)
    throw new Error('LIQUIDITY_REMOVED');
  if (pool.transfers !== 'ENABLED')
    throw new Error('TOKEN_TRANSFER_' + pool.transfers);
  if (!pool.quoteUsd) throw new Error('QUOTE_USD_UNAVAILABLE');
  if (
    pool.observedAt < pool.fees.validFrom ||
    pool.observedAt >= pool.fees.validUntil
  )
    throw new Error('FEE_SCHEDULE_UNAVAILABLE');
}
function cpmm(
  pool: PoolSnapshot,
  side: 'BUY' | 'SELL',
  input: bigint,
): PoolQuote {
  if (input <= 0n || input >= 10n ** 38n)
    throw new Error('INVALID_INPUT_AMOUNT');
  const buy = side === 'BUY',
    x = BigInt(buy ? pool.quoteReserve : pool.baseReserve),
    y = BigInt(buy ? pool.baseReserve : pool.quoteReserve);
  const inDecimals = buy ? pool.quoteDecimals : pool.baseDecimals,
    outDecimals = buy ? pool.baseDecimals : pool.quoteDecimals;
  const quoteUsd = toAtomic(pool.quoteUsd!),
    baseUsd =
      (BigInt(pool.quoteReserve) * scale(pool.baseDecimals) * quoteUsd) /
      (BigInt(pool.baseReserve) * scale(pool.quoteDecimals));
  const inUsd = buy ? quoteUsd : baseUsd,
    outUsd = buy ? baseUsd : quoteUsd;
  const fees: FeeComponent[] = [];
  const component = (
    category: FeeComponent['category'],
    amount: bigint,
    output = false,
  ) => {
    if (!amount) return;
    const decimals = output ? outDecimals : inDecimals;
    fees.push({
      category,
      asset: output
        ? buy
          ? pool.baseMint
          : pool.quoteMint
        : buy
          ? pool.quoteMint
          : pool.baseMint,
      amountUnits: amount.toString(),
      decimals,
      usd: fromAtomic((amount * (output ? outUsd : inUsd)) / scale(decimals)),
      includedInQuote: true,
    });
  };
  const transferFee = (
    amount: bigint,
    rule: PoolSnapshot['baseTransferFee'],
  ) =>
    rule
      ? min(ceil(amount * BigInt(rule.bps), BPS), BigInt(rule.maximumUnits))
      : 0n;
  const inputTransfer = transferFee(
    input,
    buy ? pool.quoteTransferFee : pool.baseTransferFee,
  );
  component('TRANSFER', inputTransfer);
  const netInput = input - inputTransfer;
  let total = 0n,
    external = 0n;
  for (const [key, category] of [
    ['lpBps', 'LP'],
    ['protocolBps', 'PROTOCOL'],
    ['creatorBps', 'CREATOR'],
    ['routingBps', 'ROUTING'],
    ['integratorBps', 'INTEGRATOR'],
  ] as const) {
    const fee = ceil(netInput * BigInt(pool.fees[key]), BPS);
    total += fee;
    if (category !== 'LP') external += fee;
    component(category, fee);
  }
  const effective = netInput - total;
  if (effective <= 0n) throw new Error('AMOUNT_BELOW_FEE_PRECISION');
  const grossOutput = (y * effective) / (x + effective);
  const outputTransfer = transferFee(
    grossOutput,
    buy ? pool.baseTransferFee : pool.quoteTransferFee,
  );
  const output = grossOutput - outputTransfer;
  if (output <= 0n) throw new Error('OUTPUT_BELOW_PRECISION');
  component('TRANSFER', outputTransfer, true);
  const nextX = x + netInput - external,
    nextY = y - grossOutput;
  const updatedPool = {
    ...pool,
    id: stableId([
      'hypothetical-cpmm-v1',
      pool.id,
      side,
      input.toString(),
      nextX.toString(),
      nextY.toString(),
    ]),
    baseReserve: (buy ? nextY : nextX).toString(),
    quoteReserve: (buy ? nextX : nextY).toString(),
  };
  if (nextX * nextY < x * y || nextY <= 0n)
    throw new Error('POOL_INVARIANT_VIOLATED');
  // Impact isolates curve depth, before transfer/venue fees. No separate price penalty.
  const ideal = (effective * y) / x;
  const impact =
    ideal > 0n ? ((ideal - grossOutput) * BPS * scale(18)) / ideal : 0n;
  const quoteUnits = buy ? input : output,
    baseUnits = buy ? output : input;
  return {
    input,
    output,
    grossOutput,
    fees,
    updatedPool,
    effectivePriceUsd: fromAtomic(
      (quoteUnits * scale(pool.baseDecimals) * quoteUsd) /
        (baseUnits * scale(pool.quoteDecimals)),
    ),
    marginalBeforeUsd: fromAtomic(baseUsd),
    marginalAfterUsd: fromAtomic(
      (BigInt(updatedPool.quoteReserve) * scale(pool.baseDecimals) * quoteUsd) /
        (BigInt(updatedPool.baseReserve) * scale(pool.quoteDecimals)),
    ),
    impactBps: fromAtomic(impact),
    includedFeeUsd: fees.reduce((sum, f) => sum + toAtomic(f.usd!), 0n),
  };
}
const min = (a: bigint, b: bigint) => (a < b ? a : b);
registerPoolModel('REFERENCE_CPMM_V1', { exactInput: cpmm });
export function quoteExactInput(
  pool: PoolSnapshot,
  side: 'BUY' | 'SELL',
  input: bigint,
): PoolQuote {
  validatePool(pool);
  return models.get(pool.model)!.exactInput(pool, side, input);
}
/** Minimum integer input delivering at least the required net output, with bounded integer search. */
export function quoteExactOutput(
  pool: PoolSnapshot,
  side: 'BUY' | 'SELL',
  output: bigint,
): PoolQuote {
  validatePool(pool);
  const reserve = BigInt(side === 'BUY' ? pool.baseReserve : pool.quoteReserve);
  if (output <= 0n || output >= reserve)
    throw new Error('INSUFFICIENT_POOL_DEPTH');
  const tryQuote = (n: bigint): PoolQuote | null => {
    try {
      return quoteExactInput(pool, side, n);
    } catch (e) {
      if (
        e instanceof Error &&
        ['OUTPUT_BELOW_PRECISION', 'AMOUNT_BELOW_FEE_PRECISION'].includes(
          e.message,
        )
      )
        return null;
      throw e;
    }
  };
  let hi = 1n;
  while ((tryQuote(hi)?.output ?? 0n) < output) {
    hi *= 2n;
    if (hi >= 10n ** 37n) throw new Error('INSUFFICIENT_POOL_DEPTH');
  }
  let lo = 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((tryQuote(mid)?.output ?? 0n) >= output) hi = mid;
    else lo = mid + 1n;
  }
  const result = quoteExactInput(pool, side, lo);
  // Exact-output execution debits the searched input but transfers only the requested net output.
  // Keep integer rounding surplus in the pool rather than silently crediting fewer tokens than the audit.
  const buy = side === 'BUY',
    transfer = buy ? pool.baseTransferFee : pool.quoteTransferFee;
  const withheld = (gross: bigint) =>
    transfer
      ? min(
          ceil(gross * BigInt(transfer.bps), BPS),
          BigInt(transfer.maximumUnits),
        )
      : 0n;
  let low = output,
    high = result.grossOutput;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (mid - withheld(mid) >= output) high = mid;
    else low = mid + 1n;
  }
  const gross = low,
    retained = result.grossOutput - gross;
  const outMint = buy ? pool.baseMint : pool.quoteMint,
    outDecimals = buy ? pool.baseDecimals : pool.quoteDecimals;
  result.fees = result.fees.filter(
    (f) => !(f.category === 'TRANSFER' && f.asset === outMint),
  );
  const transferAmount = withheld(gross),
    quoteUsd = toAtomic(pool.quoteUsd!);
  const baseUsd = toAtomic(result.marginalBeforeUsd);
  if (transferAmount)
    result.fees.push({
      category: 'TRANSFER',
      asset: outMint,
      amountUnits: transferAmount.toString(),
      decimals: outDecimals,
      usd: fromAtomic(
        (transferAmount * (buy ? baseUsd : quoteUsd)) / scale(outDecimals),
      ),
      includedInQuote: true,
    });
  result.includedFeeUsd = result.fees.reduce(
    (sum, f) => sum + toAtomic(f.usd!),
    0n,
  );
  result.output = output;
  result.grossOutput = gross;
  if (buy)
    result.updatedPool.baseReserve = (
      BigInt(result.updatedPool.baseReserve) + retained
    ).toString();
  else
    result.updatedPool.quoteReserve = (
      BigInt(result.updatedPool.quoteReserve) + retained
    ).toString();
  const quoteUnits = buy ? result.input : output,
    baseUnits = buy ? output : result.input;
  result.effectivePriceUsd = fromAtomic(
    (quoteUnits * scale(pool.baseDecimals) * quoteUsd) /
      (baseUnits * scale(pool.quoteDecimals)),
  );
  result.marginalAfterUsd = fromAtomic(
    (BigInt(result.updatedPool.quoteReserve) *
      scale(pool.baseDecimals) *
      quoteUsd) /
      (BigInt(result.updatedPool.baseReserve) * scale(pool.quoteDecimals)),
  );
  result.updatedPool.id = stableId([
    'hypothetical-cpmm-v1',
    pool.id,
    side,
    result.input.toString(),
    output.toString(),
    result.updatedPool.baseReserve,
    result.updatedPool.quoteReserve,
  ]);
  return result;
}
