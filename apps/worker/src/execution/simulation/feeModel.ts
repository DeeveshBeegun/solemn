import { fromAtomic, toAtomic } from '@solemn/shared';
import type { ExecutionConfig, FeeComponent, NativeUsd } from '@solemn/shared';
import { ceil } from './poolModels.js';
export function networkFees(
  config: ExecutionConfig,
  at: string,
  fx: NativeUsd | null,
): {
  fees: FeeComponent[];
  usd: bigint;
  lamports: bigint;
  unknown: bigint;
  rate: bigint | null;
} {
  const n = config.network;
  if (at < n.validFrom || at >= n.validUntil)
    throw new Error('NETWORK_FEE_SCHEDULE_UNAVAILABLE');
  const rate =
    fx &&
    fx.availableAt <= at &&
    fx.observedAt <= at &&
    Date.parse(at) - Date.parse(fx.observedAt) <= config.maxQuoteAgeMs
      ? toAtomic(fx.priceUsd)
      : null;
  const fees: FeeComponent[] = [];
  const add = (category: FeeComponent['category'], amount: bigint) => {
    if (amount)
      fees.push({
        category,
        asset: 'SOL',
        amountUnits: amount.toString(),
        decimals: 9,
        usd:
          rate === null ? null : fromAtomic(ceil(amount * rate, 1000000000n)),
        includedInQuote: false,
      });
  };
  add(
    'NETWORK_BASE',
    BigInt(n.baseLamportsPerSignature) * BigInt(n.signatures),
  );
  add(
    'PRIORITY',
    n.format === 'V1'
      ? BigInt(n.absolutePriorityLamports)
      : ceil(
          BigInt(n.computeUnitLimit) * BigInt(n.microLamportsPerCu),
          1000000n,
        ),
  );
  // Explicit route tip is modeled as conditional on successful execution, not validator fees on failure.
  const lamports = fees.reduce((sum, f) => sum + BigInt(f.amountUnits), 0n);
  return {
    fees,
    rate,
    lamports,
    usd: fees.reduce(
      (sum, f) => sum + (f.usd === null ? 0n : toAtomic(f.usd)),
      0n,
    ),
    unknown: rate === null ? lamports : 0n,
  };
}
