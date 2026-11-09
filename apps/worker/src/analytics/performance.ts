import { fromAtomic, toAtomic } from '@solemn/shared';
import type {
  PaperOrderRecord,
  PaperPortfolioState,
  PaperPosition,
} from '@solemn/shared';
import { percentage, signed } from '../portfolio/decimal.js';
import type { CapturedPortfolio, EquityPoint } from './contracts.js';
import { inPeriod } from './contracts.js';
import { closedPositionMetrics } from './closedPositionMetrics.js';
import { analyzeDrawdown } from './drawdown.js';
import { analyzeCosts } from './executionCostAnalyzer.js';

export const groupOrders = (orders: readonly PaperOrderRecord[]) => {
  const grouped = new Map<string, PaperOrderRecord[]>();
  for (const order of orders) {
    const existing = grouped.get(order.positionId);
    if (existing) existing.push(order);
    else grouped.set(order.positionId, [order]);
  }
  return grouped;
};
const active = (position: PaperPosition) => position.status !== 'CLOSED';
function boundary(
  state: PaperPortfolioState,
  at: string,
  stored: EquityPoint | undefined,
): EquityPoint {
  if (state.executionUncertain)
    return { at, equityUsd: null, reason: 'EXECUTION_UNCERTAIN' };
  if (stored) return stored;
  if (!state.positions.some(active))
    return {
      at,
      equityUsd: fromAtomic(
        toAtomic(state.availableCashUsd) + toAtomic(state.reservedCashUsd),
      ),
      reason: 'BOUNDARY_FROM_LEDGER',
    };
  return { at, equityUsd: null, reason: 'MISSING_BOUNDARY_VALUATION' };
}
export function analyzePerformance(input: CapturedPortfolio) {
  const { startState, endState, start, end, journal } = input;
  const orders = journal.flatMap((e) => e.orders),
    priorAndCurrent = groupOrders([...input.priorOrders, ...orders]);
  const closed = endState.positions.filter(
    (p) => p.closedAt !== null && inPeriod(p.closedAt, start, end),
  );
  const open = endState.positions.filter(active);
  const periods = [...closed, ...open];
  const entered = orders.filter((o) => o.order.side === 'BUY'),
    exited = orders.filter((o) => o.order.side === 'SELL');
  const deployed = entered.reduce(
    (sum, o) =>
      sum +
      (o.order.status === 'FILLED'
        ? toAtomic(o.notionalUsd) + toAtomic(o.trades[0]!.feesUsd)
        : 0n),
    0n,
  );
  const costs = analyzeCosts(orders, deployed);
  const fees = (s: PaperPortfolioState) =>
    toAtomic(s.buyFeesUsd) + toAtomic(s.sellFeesUsd);
  if (toAtomic(costs.bookedFeesUsd) !== fees(endState) - fees(startState))
    throw new Error('Execution fees do not reconcile with period ledger');
  const tradeRows = periods.map((position) => {
    const positionOrders = priorAndCurrent.get(position.id) ?? [],
      entryOrder = positionOrders.find(
        (o) => o.order.side === 'BUY' && o.order.status === 'FILLED',
      );
    const cost = analyzeCosts(
        positionOrders,
        toAtomic(position.initialCostBasisUsd),
      ),
      net = signed(position.realizedPnlUsd);
    if (toAtomic(cost.bookedFeesUsd) !== toAtomic(position.feesUsd))
      throw new Error('Position fees do not reconcile with execution records');
    const isClosed = position.status === 'CLOSED';
    return {
      positionId: position.id,
      signalId: position.signalId,
      mint: position.mint,
      poolAddress: position.poolAddress,
      status: position.status,
      openedAt: position.openedAt,
      closedAt: position.closedAt,
      carryIn: Date.parse(position.openedAt) < Date.parse(start),
      holdingSeconds:
        (Date.parse(position.closedAt ?? end) - Date.parse(position.openedAt)) /
        1000,
      quantity: position.quantity,
      initialCostBasisUsd: position.initialCostBasisUsd,
      remainingBasisUsd: position.costBasisUsd,
      bookedRealizedPnlUsd: position.realizedPnlUsd,
      closedNetPnlUsd: isClosed ? position.realizedPnlUsd : null,
      grossBeforeBookedFeesUsd: isClosed
        ? fromAtomic(net + toAtomic(position.feesUsd))
        : null,
      closedReturnPercent: isClosed
        ? percentage(net, toAtomic(position.initialCostBasisUsd))
        : null,
      bookedFeesUsd: position.feesUsd,
      identifiedCostsUsd: cost.totalIdentifiedCostsUsd,
      costsComplete: cost.complete,
      networkFeesUsd: cost.networkFeesUsd,
      exitFills: positionOrders.filter(
        (o) => o.order.side === 'SELL' && o.order.status === 'FILLED',
      ).length,
      failedExits: positionOrders.filter(
        (o) => o.order.side === 'SELL' && o.order.status === 'FAILED',
      ).length,
      venue: entryOrder?.audit?.context.pool?.model ?? 'UNKNOWN',
      entryImpactBps: entryOrder?.audit?.impactBps ?? null,
    };
  });
  const atStart = input.equity.find((p) => p.at === start);
  const startsWithChange = journal.some(
    (row) =>
      Date.parse(row.timestamp) === Date.parse(start) &&
      row.postings.some((p) => p.type !== 'INITIAL_BALANCE'),
  );
  const opening = boundary(
    startState,
    start,
    startsWithChange ? undefined : atStart,
  );
  const ending = boundary(
    endState,
    end,
    input.equity.find((p) => p.at === end),
  );
  const curve = [
    opening,
    ...input.equity.filter(
      (p) => p.at !== end && (p.at !== start || startsWithChange),
    ),
    ending,
  ];
  const drawdown = analyzeDrawdown(curve, input.cadence, start, end);
  const beginningEquity =
      opening.equityUsd === null ? null : toAtomic(opening.equityUsd),
    endingEquity =
      ending.equityUsd === null ? null : toAtomic(ending.equityUsd);
  let basisTime = 0n,
    cursor = Date.parse(start),
    basis = toAtomic(startState.investedCostBasisUsd);
  for (const row of journal) {
    const time = Date.parse(row.timestamp);
    basisTime += basis * BigInt(time - cursor);
    basis = toAtomic(row.stateAfter.investedCostBasisUsd);
    cursor = time;
  }
  const elapsed = Date.parse(end) - Date.parse(start),
    initial = toAtomic(input.definition.policy.initialBalanceUsd);
  basisTime += basis * BigInt(Date.parse(end) - cursor);
  const realized =
    signed(endState.realizedPnlUsd) - signed(startState.realizedPnlUsd);
  const endUnknown =
    endState.executionUncertain || startState.executionUncertain;
  const filled = (records: PaperOrderRecord[]) =>
    records.filter((o) => o.order.status === 'FILLED').length;
  return {
    closed,
    tradeRows,
    curve,
    portfolio: {
      initialBankrollUsd: input.definition.policy.initialBalanceUsd,
      openingMarkedEquityUsd: opening.equityUsd,
      endingCashUsd: endState.availableCashUsd,
      endingReservedCashUsd: endState.reservedCashUsd,
      endingMarkedEquityUsd: ending.equityUsd,
      knownRealizedPnlUsd: fromAtomic(realized),
      realizedNetPnlUsd: endUnknown ? null : fromAtomic(realized),
      endingUnrealizedPnlUsd:
        endingEquity === null ? null : endState.unrealizedPnlUsd,
      netMarkedPnlUsd:
        beginningEquity === null || endingEquity === null
          ? null
          : fromAtomic(endingEquity - beginningEquity),
      netReturnPercent:
        beginningEquity === null ||
        beginningEquity === 0n ||
        endingEquity === null
          ? null
          : percentage(endingEquity - beginningEquity, beginningEquity),
      capitalDeployedUsd: fromAtomic(deployed),
      averageCapitalUtilizationPercent: elapsed
        ? percentage(basisTime, initial * BigInt(elapsed))
        : null,
      openCostBasisUsd: endState.investedCostBasisUsd,
      unpricedPositions: open.filter(
        (p) =>
          endingEquity === null &&
          (!p.mark ||
            p.valuationStale ||
            p.liquidationUncertain ||
            p.status === 'EXIT_BLOCKED' ||
            Date.parse(end) - Date.parse(p.mark.observedAt) >
              input.definition.policy.maxPriceAgeSeconds * 1000),
      ).length,
      ...drawdown,
    },
    trading: {
      ...closedPositionMetrics(closed),
      openPositions: open.length,
      blockedExits: open.filter((p) => p.status === 'EXIT_BLOCKED').length,
      entryOrders: entered.length,
      exitOrders: exited.length,
      filledEntries: filled(entered),
      filledExits: filled(exited),
      filledOrders: filled(orders),
      failedOrders: orders.filter((o) => o.order.status === 'FAILED').length,
      failedExits: exited.filter((o) => o.order.status === 'FAILED').length,
      unverifiableExecutions: costs.unverifiable,
      entryFillRatePercent: entered.length
        ? percentage(BigInt(filled(entered)), BigInt(entered.length))
        : null,
      exitFillRatePercent: exited.length
        ? percentage(BigInt(filled(exited)), BigInt(exited.length))
        : null,
    },
    costs: {
      ...costs,
      averageBookedCostPerClosedPositionUsd: closed.length
        ? fromAtomic(
            closed.reduce((sum, p) => sum + toAtomic(p.feesUsd), 0n) /
              BigInt(closed.length),
          )
        : null,
    },
  };
}
