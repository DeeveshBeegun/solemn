import {
  fromAtomic,
  paperPortfolioStateSchema,
  toAtomic,
} from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperPortfolioState,
  PaperPosting,
} from '@solemn/shared';
import { HUNDRED, percentage, signed } from './decimal.js';
export function initialPortfolio(
  definition: PaperAccountDefinition,
): PaperPortfolioState {
  const initial = definition.policy.initialBalanceUsd;
  return paperPortfolioStateSchema.parse({
    id: definition.id,
    asOf: definition.createdAt,
    availableCashUsd: initial,
    reservedCashUsd: '0',
    investedCostBasisUsd: '0',
    positionValueUsd: '0',
    realizedPnlUsd: '0',
    unrealizedPnlUsd: '0',
    buyFeesUsd: '0',
    sellFeesUsd: '0',
    equityUsd: initial,
    peakEquityUsd: initial,
    drawdownPercent: '0',
    totalReturnPercent: '0',
    day: definition.createdAt.slice(0, 10),
    dayStartingEquityUsd: initial,
    dailyLossPercent: '0',
    status: 'ACTIVE',
    haltReason: null,
    entryBlockReasons: [],
    positions: [],
  });
}
export function initialPosting(
  definition: PaperAccountDefinition,
): PaperPosting {
  return {
    type: 'INITIAL_BALANCE',
    availableDeltaUsd: definition.policy.initialBalanceUsd,
    reservedDeltaUsd: '0',
    realizedDeltaUsd: '0',
    buyFeesDeltaUsd: '0',
    sellFeesDeltaUsd: '0',
  };
}
export function applyPosting(
  state: PaperPortfolioState,
  posting: PaperPosting,
): void {
  state.availableCashUsd = fromAtomic(
    toAtomic(state.availableCashUsd) + signed(posting.availableDeltaUsd),
  );
  state.reservedCashUsd = fromAtomic(
    toAtomic(state.reservedCashUsd) + signed(posting.reservedDeltaUsd),
  );
  state.realizedPnlUsd = fromAtomic(
    signed(state.realizedPnlUsd) + signed(posting.realizedDeltaUsd),
  );
  state.buyFeesUsd = fromAtomic(
    toAtomic(state.buyFeesUsd) + toAtomic(posting.buyFeesDeltaUsd),
  );
  state.sellFeesUsd = fromAtomic(
    toAtomic(state.sellFeesUsd) + toAtomic(posting.sellFeesDeltaUsd),
  );
  if (
    state.availableCashUsd.startsWith('-') ||
    state.reservedCashUsd.startsWith('-')
  )
    throw new Error('Paper cash invariant violated');
}
export function reconcilePortfolio(
  state: PaperPortfolioState,
  definition: PaperAccountDefinition,
  at: string,
): void {
  if (at.slice(0, 10) !== state.day) {
    state.day = at.slice(0, 10);
    state.dayStartingEquityUsd = state.equityUsd;
  }
  state.asOf = at;
  const active = state.positions.filter(
    (position) => position.status !== 'CLOSED',
  );
  for (const position of active) {
    position.valuationStale ||=
      position.mark === null ||
      !position.mark.healthy ||
      Date.parse(at) - Date.parse(position.mark.observedAt) >
        definition.policy.maxPriceAgeSeconds * 1000;
    position.unrealizedPnlUsd = fromAtomic(
      toAtomic(position.markValueUsd) - toAtomic(position.costBasisUsd),
    );
  }
  state.investedCostBasisUsd = fromAtomic(
    active.reduce((sum, position) => sum + toAtomic(position.costBasisUsd), 0n),
  );
  state.positionValueUsd = fromAtomic(
    active.reduce((sum, position) => sum + toAtomic(position.markValueUsd), 0n),
  );
  state.unrealizedPnlUsd = fromAtomic(
    active.reduce(
      (sum, position) => sum + signed(position.unrealizedPnlUsd),
      0n,
    ),
  );
  state.equityUsd = fromAtomic(
    toAtomic(state.availableCashUsd) +
      toAtomic(state.reservedCashUsd) +
      toAtomic(state.positionValueUsd),
  );
  if (
    active.every((position) => !position.valuationStale) &&
    toAtomic(state.equityUsd) > toAtomic(state.peakEquityUsd)
  )
    state.peakEquityUsd = state.equityUsd;
  const peak = toAtomic(state.peakEquityUsd),
    equity = toAtomic(state.equityUsd),
    day = toAtomic(state.dayStartingEquityUsd);
  state.drawdownPercent = percentage(peak > equity ? peak - equity : 0n, peak);
  state.dailyLossPercent = percentage(day > equity ? day - equity : 0n, day);
  state.totalReturnPercent = percentage(
    equity - toAtomic(definition.policy.initialBalanceUsd),
    toAtomic(definition.policy.initialBalanceUsd),
  );
  const reasons: string[] = [];
  if (
    day === 0n ||
    (day > equity &&
      (day - equity) * HUNDRED >=
        day * toAtomic(definition.policy.maxDailyLossPercent))
  )
    reasons.push('DAILY_LOSS_LIMIT');
  if (active.some((position) => position.valuationStale))
    reasons.push('POSITION_VALUATION_STALE');
  if (active.some((position) => position.liquidationUncertain))
    reasons.push('LIQUIDATION_VALUE_UNCERTAIN');
  if (active.some((position) => position.status === 'EXIT_BLOCKED'))
    reasons.push('UNRESOLVED_BLOCKED_EXIT');
  if (
    peak > equity &&
    (peak - equity) * HUNDRED >=
      peak * toAtomic(definition.policy.maxTotalDrawdownPercent)
  ) {
    state.status = 'HALTED';
    state.haltReason ??= 'TOTAL_DRAWDOWN_LIMIT';
  }
  state.entryBlockReasons = reasons;
  if (state.status !== 'HALTED')
    state.status = reasons.length ? 'ENTRIES_BLOCKED' : 'ACTIVE';
  assertAccounting(state, definition);
}
export function assertAccounting(
  state: PaperPortfolioState,
  definition: PaperAccountDefinition,
): void {
  paperPortfolioStateSchema.parse(state);
  const totalCashAndBasis =
    toAtomic(state.availableCashUsd) +
    toAtomic(state.reservedCashUsd) +
    toAtomic(state.investedCostBasisUsd);
  if (
    totalCashAndBasis !==
    toAtomic(definition.policy.initialBalanceUsd) + signed(state.realizedPnlUsd)
  )
    throw new Error('Paper ledger/cost-basis reconciliation failed');
  for (const position of state.positions) {
    if (
      toAtomic(position.quantity) > toAtomic(position.originalQuantity) ||
      toAtomic(position.costBasisUsd) > toAtomic(position.initialCostBasisUsd)
    )
      throw new Error('Paper position invariant violated');
    if ((position.status === 'CLOSED') !== (toAtomic(position.quantity) === 0n))
      throw new Error('Closed position requires a full exit fill');
  }
}
