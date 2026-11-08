import { fromAtomic, toAtomic } from '@solemn/shared';
import type { PaperPolicy } from '@solemn/shared';
import {
  feeFor,
  moneyNotional,
  percentOf,
  quantityStep,
} from '../portfolio/decimal.js';
export function sizePosition(
  equityUsd: string,
  availableCashUsd: string,
  fillPriceUsd: string,
  policy: PaperPolicy,
): { budgetUsd: string; quantity: string; totalCostUsd: string } | null {
  const allocation = percentOf(toAtomic(equityUsd), policy.maxPositionPercent),
    cash = toAtomic(availableCashUsd);
  const budget = allocation < cash ? allocation : cash,
    step = quantityStep(policy.quantityDecimals),
    price = toAtomic(fillPriceUsd);
  if (price <= 0n || budget < toAtomic(policy.minimumOrderUsd)) return null;
  let low = 0n,
    high = (budget * 10n ** 18n) / price / step;
  const cost = (units: bigint) => {
    const notional = moneyNotional(
      fromAtomic(units * step),
      fillPriceUsd,
      'BUY',
    );
    return notional + feeFor(notional, policy.buyFeePercent);
  };
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (cost(mid) <= budget) low = mid;
    else high = mid - 1n;
  }
  const quantity = fromAtomic(low * step);
  if (
    low === 0n ||
    moneyNotional(quantity, fillPriceUsd, 'BUY') <
      toAtomic(policy.minimumOrderUsd)
  )
    return null;
  return {
    budgetUsd: fromAtomic(budget),
    quantity,
    totalCostUsd: fromAtomic(cost(low)),
  };
}
