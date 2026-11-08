import { fromAtomic, toAtomic } from '@solemn/shared';
import type {
  ExecutionObservation,
  PaperPolicy,
  PaperPosition,
} from '@solemn/shared';
import { executionPrice } from '../execution/paperExecutor.js';
import { feeFor, HUNDRED, moneyNotional, quantize, signed } from './decimal.js';
export function updatePositionMark(
  position: PaperPosition,
  observation: ExecutionObservation,
  policy: PaperPolicy,
): void {
  const price = executionPrice(observation, policy);
  if (!price || observation.side !== 'SELL')
    throw new Error('A valid sell-side mark is required');
  position.mark = observation;
  const gross = moneyNotional(position.quantity, price, 'SELL');
  position.markValueUsd = fromAtomic(
    gross - feeFor(gross, policy.sellFeePercent),
  );
  position.valuationStale = false;
  position.liquidationUncertain =
    observation.liquidityUsd === null ||
    toAtomic(observation.liquidityUsd) === 0n ||
    gross * HUNDRED >
      toAtomic(observation.liquidityUsd) *
        toAtomic(policy.maxLiquidityParticipationPercent);
  if (
    position.highestSellPriceUsd === null ||
    toAtomic(price) > toAtomic(position.highestSellPriceUsd)
  )
    position.highestSellPriceUsd = price;
  if (
    position.target2Complete &&
    (position.trailingPeakUsd === null ||
      toAtomic(price) > toAtomic(position.trailingPeakUsd))
  )
    position.trailingPeakUsd = price;
}
export function chooseExit(
  position: PaperPosition,
  sellPrice: string,
  at: string,
  policy: PaperPolicy,
  criticalRisk: boolean,
): { reason: string; quantity: string } | null {
  const price = toAtomic(sellPrice),
    entry = toAtomic(position.entryPriceUsd);
  if (criticalRisk)
    return { reason: 'CRITICAL_TOKEN_RISK', quantity: position.quantity };
  if (price * HUNDRED <= entry * (HUNDRED - toAtomic(policy.stopLossPercent)))
    return { reason: 'STOP_LOSS', quantity: position.quantity };
  if (
    position.target2Complete &&
    position.trailingPeakUsd !== null &&
    price * HUNDRED <=
      toAtomic(position.trailingPeakUsd) *
        (HUNDRED - toAtomic(policy.trailingStopPercent))
  )
    return { reason: 'TRAILING_STOP', quantity: position.quantity };
  if (
    Date.parse(at) - Date.parse(position.openedAt) >=
    policy.maxHoldingMinutes * 60000
  )
    return { reason: 'MAX_HOLDING_TIME', quantity: position.quantity };
  if (position.pendingExitReason && position.pendingExitQuantity)
    return {
      reason: position.pendingExitReason,
      quantity: position.pendingExitQuantity,
    };
  if (
    !position.target1Complete &&
    price * HUNDRED >= entry * (HUNDRED + toAtomic(policy.takeProfit1Percent))
  )
    return {
      reason: 'TAKE_PROFIT_1',
      quantity: fromAtomic(
        quantize(
          (toAtomic(position.originalQuantity) *
            toAtomic(policy.takeProfit1Fraction)) /
            HUNDRED,
          policy.quantityDecimals,
        ),
      ),
    };
  if (
    position.target1Complete &&
    !position.target2Complete &&
    price * HUNDRED >= entry * (HUNDRED + toAtomic(policy.takeProfit2Percent))
  )
    return {
      reason: 'TAKE_PROFIT_2',
      quantity: fromAtomic(
        quantize(
          (toAtomic(position.quantity) * toAtomic(policy.takeProfit2Fraction)) /
            HUNDRED,
          policy.quantityDecimals,
        ),
      ),
    };
  return null;
}
export function applyExitFill(
  position: PaperPosition,
  quantity: string,
  netProceeds: bigint,
  fee: bigint,
  reason: string,
  at: string,
  sellPrice: string,
): bigint {
  const held = toAtomic(position.quantity),
    sold = toAtomic(quantity);
  if (sold <= 0n || sold > held) throw new Error('Exit exceeds token holdings');
  const basis =
    sold === held
      ? toAtomic(position.costBasisUsd)
      : (toAtomic(position.costBasisUsd) * sold) / held;
  position.quantity = fromAtomic(held - sold);
  position.costBasisUsd = fromAtomic(toAtomic(position.costBasisUsd) - basis);
  const realized = netProceeds - basis;
  position.realizedPnlUsd = fromAtomic(
    signed(position.realizedPnlUsd) + realized,
  );
  position.feesUsd = fromAtomic(toAtomic(position.feesUsd) + fee);
  position.pendingExitReason = null;
  position.pendingExitQuantity = null;
  position.blockedReason = null;
  position.status = sold === held ? 'CLOSED' : 'OPEN';
  if (reason === 'TAKE_PROFIT_1') position.target1Complete = true;
  if (reason === 'TAKE_PROFIT_2') {
    position.target2Complete = true;
    position.trailingPeakUsd = sellPrice;
  }
  if (sold === held) {
    position.closedAt = at;
    position.markValueUsd = '0';
    position.unrealizedPnlUsd = '0';
  }
  return realized;
}
