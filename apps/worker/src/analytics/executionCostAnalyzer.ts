import { fromAtomic, toAtomic } from '@solemn/shared';
import type { PaperOrderRecord } from '@solemn/shared';
import { percentage } from '../portfolio/decimal.js';

export function quoteMovement(record: PaperOrderRecord): bigint | null {
  const audit = record.audit,
    pool = audit?.context.pool,
    quotedPool = audit?.context.quote.pool;
  if (
    audit?.outcome !== 'FILLED' ||
    !pool?.quoteUsd ||
    !quotedPool ||
    pool.quoteMint !== quotedPool.quoteMint ||
    pool.quoteDecimals !== quotedPool.quoteDecimals
  )
    return null;
  const units =
    record.order.side === 'BUY'
      ? BigInt(audit.inputUnits) - BigInt(audit.quotedInputUnits)
      : BigInt(audit.quotedOutputUnits) - BigInt(audit.outputUnits);
  return (units * toAtomic(pool.quoteUsd)) / 10n ** BigInt(pool.quoteDecimals);
}

/** Fee totals use booked charges. Price impact and quote movement are overlapping diagnostics. */
export function analyzeCosts(
  orders: readonly PaperOrderRecord[],
  capitalDeployed: bigint,
) {
  let entry = 0n,
    exit = 0n,
    legacySlippage = 0n,
    network = 0n,
    failedFees = 0n,
    impact = 0n,
    impactCount = 0,
    movement = 0n,
    movementCount = 0,
    adverseMovement = 0n,
    latencySum = 0n,
    latencyCount = 0;
  let legacyOrders = 0,
    unknownFeeOrders = 0,
    unverifiable = 0,
    unknownLamports = 0n;
  const knownCategories = new Map<string, bigint>(),
    unknownCategories = new Set<string>();
  for (const order of orders) {
    const audit = order.audit,
      fee = toAtomic(order.order.actualFeesUsd ?? '0');
    if (order.order.side === 'BUY') entry += fee;
    else exit += fee;
    if (!audit) {
      legacyOrders++;
      if (order.order.status === 'FILLED')
        legacySlippage += toAtomic(order.slippageUsd);
      continue;
    }
    latencySum += BigInt(audit.latencyMs);
    latencyCount++;
    const missingUsd =
      audit.fees.some((f) => f.usd === null) ||
      BigInt(audit.unpricedFeeLamports) > 0n;
    if (missingUsd || audit.outcome === 'UNVERIFIABLE') unknownFeeOrders++;
    if (audit.outcome === 'UNVERIFIABLE') unverifiable++;
    unknownLamports += BigInt(audit.unpricedFeeLamports);
    network += toAtomic(audit.networkFeeUsd);
    if (audit.outcome === 'FAILED_ON_CHAIN')
      failedFees += toAtomic(audit.networkFeeUsd);
    if (audit.outcome === 'FILLED' && audit.impactBps !== null) {
      impact += toAtomic(audit.impactBps);
      impactCount++;
    }
    const adverse = quoteMovement(order);
    if (adverse !== null) {
      movement += adverse;
      if (adverse > 0n) adverseMovement += adverse;
      movementCount++;
    }
    for (const component of audit.fees) {
      if (component.usd === null) unknownCategories.add(component.category);
      else
        knownCategories.set(
          component.category,
          (knownCategories.get(component.category) ?? 0n) +
            toAtomic(component.usd),
        );
    }
  }
  const fees = entry + exit,
    totalKnown = fees + legacySlippage,
    complete = legacyOrders === 0 && unknownFeeOrders === 0;
  const category = (key: string) =>
    complete && !unknownCategories.has(key)
      ? fromAtomic(knownCategories.get(key) ?? 0n)
      : null;
  const venues = [
    'LP',
    'PROTOCOL',
    'CREATOR',
    'ROUTING',
    'INTEGRATOR',
    'TRANSFER',
  ];
  return {
    orders: orders.length,
    entryFeesUsd: fromAtomic(entry),
    exitFeesUsd: fromAtomic(exit),
    bookedFeesUsd: fromAtomic(fees),
    knownNetworkFeesUsd: fromAtomic(network),
    networkFeesUsd: complete ? fromAtomic(network) : null,
    priorityFeesUsd: category('PRIORITY'),
    tipsUsd: category('TIP'),
    venueFeesUsd: complete
      ? fromAtomic(
          venues.reduce((sum, k) => sum + (knownCategories.get(k) ?? 0n), 0n),
        )
      : null,
    knownFeeCategoriesUsd: Object.fromEntries(
      [...knownCategories].map(([k, n]) => [k, fromAtomic(n)]),
    ),
    unknownFeeCategories: [...unknownCategories].sort(),
    failedTransactionFeesUsd: complete ? fromAtomic(failedFees) : null,
    knownFailedTransactionFeesUsd: fromAtomic(failedFees),
    unknownFeeLamports: unknownLamports.toString(),
    legacyOrders,
    unknownFeeOrders,
    unverifiable,
    complete,
    legacySimulatedSlippageUsd: legacyOrders
      ? fromAtomic(legacySlippage)
      : null,
    averageImpactBps: impactCount
      ? fromAtomic(impact / BigInt(impactCount))
      : null,
    impactSample: impactCount,
    quoteMovementUsd: movementCount ? fromAtomic(movement) : null,
    quoteMovementSample: movementCount,
    adverseQuoteMovementUsd: movementCount ? fromAtomic(adverseMovement) : null,
    averageSimulatedLatencyMs: latencyCount
      ? fromAtomic((latencySum * 10n ** 18n) / BigInt(latencyCount))
      : null,
    totalIdentifiedCostsUsd: fromAtomic(totalKnown),
    identifiedCostsPercentOfDeployed:
      capitalDeployed > 0n ? percentage(totalKnown, capitalDeployed) : null,
  };
}
