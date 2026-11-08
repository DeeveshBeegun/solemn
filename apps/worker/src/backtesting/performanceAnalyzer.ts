import { fromAtomic, stableId, toAtomic } from '@solemn/shared';
import type {
  BacktestMetrics,
  BacktestPlan,
  EquitySnapshot,
  PaperCommand,
  PaperPortfolioState,
  PaperTransition,
  StrategyDecision,
  StoredDataset,
} from '@solemn/shared';
import { HUNDRED, SCALE, percentage, signed } from '../portfolio/decimal.js';
export class PerformanceAnalyzer {
  readonly tokens = new Set<string>();
  readonly blockedTokens = new Set<string>();
  evaluations = 0;
  riskBlocked = 0;
  signals = 0;
  rejected = 0;
  rejectedByRisk = 0;
  missingExecution = 0;
  unknownRisk = 0;
  insufficientHistory = 0;
  stalePrices = 0;
  unavailable = 0;
  uncertainSnapshots = 0;
  entryOrders = 0;
  exitOrders = 0;
  filledOrders = 0;
  failedOrders = 0;
  opened = 0;
  maxConcurrent = 0;
  stopExits = 0;
  tpExits = 0;
  trailExits = 0;
  timeExits = 0;
  failedExits = 0;
  slippage = 0n;
  private peak: bigint;
  private maximumDrop = 0n;
  private peakAtDrop: bigint;
  constructor(readonly plan: BacktestPlan) {
    this.peak = toAtomic(plan.paper.initialBalanceUsd);
    this.peakAtDrop = this.peak;
  }
  decision(decision: StrategyDecision) {
    this.tokens.add(decision.mint);
    this.evaluations++;
    if (decision.outcome === 'BLOCKED_BY_RISK') {
      this.riskBlocked++;
      this.blockedTokens.add(decision.mint);
    }
    if (decision.candidate) this.signals++;
    if (!decision.risk?.assessment || decision.risk.currentStatus === 'UNKNOWN')
      this.unknownRisk++;
    if (
      decision.reasons.some(
        (reason) =>
          reason.includes('HISTORY') || reason === 'CANDLE_DATA_INCOMPLETE',
      )
    )
      this.insufficientHistory++;
  }
  transition(command: PaperCommand, transition: PaperTransition) {
    if (
      command.type === 'ENTRY' &&
      transition.result.outcome === 'ENTRY_REJECTED'
    ) {
      this.rejected++;
      if (
        transition.result.reasons.some((reason) =>
          /PORTFOLIO|POSITION|COOLDOWN|CASH|RISK|SIGNAL_|SIZE/.test(reason),
        )
      )
        this.rejectedByRisk++;
    }
    if (command.type === 'MARK' && transition.result.outcome === 'STALE_DATA')
      this.stalePrices++;
    for (const record of transition.orders) {
      if (record.order.side === 'BUY') this.entryOrders++;
      else this.exitOrders++;
      if (record.order.status === 'FAILED') {
        this.failedOrders++;
        if (record.order.side === 'SELL') this.failedExits++;
      }
      if (record.order.status === 'FILLED') {
        this.filledOrders++;
        this.slippage += toAtomic(record.slippageUsd);
        if (record.order.side === 'BUY') this.opened++;
        if (record.reason === 'STOP_LOSS') this.stopExits++;
        if (record.reason.startsWith('TAKE_PROFIT')) this.tpExits++;
        if (record.reason === 'TRAILING_STOP') this.trailExits++;
        if (record.reason === 'MAX_HOLDING_TIME') this.timeExits++;
      }
    }
    this.maxConcurrent = Math.max(
      this.maxConcurrent,
      transition.state.positions.filter(
        (position) => position.status !== 'CLOSED',
      ).length,
    );
  }
  snapshot(state: PaperPortfolioState, timestamp: string): EquitySnapshot {
    const active = state.positions.filter(
        (position) => position.status !== 'CLOSED',
      ),
      reasons: string[] = [];
    if (
      active.some(
        (position) => position.mark === null || position.valuationStale,
      )
    )
      reasons.push('OPEN_POSITION_UNPRICED_OR_STALE');
    if (
      active.some(
        (position) =>
          position.liquidationUncertain || position.status === 'EXIT_BLOCKED',
      )
    )
      reasons.push('LIQUIDATION_UNCERTAIN_OR_EXIT_BLOCKED');
    const reliable = reasons.length === 0,
      equity = reliable ? toAtomic(state.equityUsd) : null;
    if (equity !== null) {
      if (equity > this.peak) this.peak = equity;
      const drop = this.peak - equity;
      if (drop * this.peakAtDrop > this.maximumDrop * this.peak) {
        this.maximumDrop = drop;
        this.peakAtDrop = this.peak;
      }
    } else this.uncertainSnapshots++;
    return {
      id: stableId(['backtest-equity-v1', this.plan.runId, timestamp]),
      runId: this.plan.runId,
      timestamp,
      availableCashUsd: state.availableCashUsd,
      reservedCashUsd: state.reservedCashUsd,
      markedPositionsUsd: reliable ? state.positionValueUsd : null,
      totalEquityUsd: reliable ? state.equityUsd : null,
      realizedPnlUsd: state.realizedPnlUsd,
      unrealizedPnlUsd: reliable ? state.unrealizedPnlUsd : null,
      drawdownPercent:
        equity === null ? null : percentage(this.peak - equity, this.peak),
      valuationQuality: reliable ? 'RELIABLE' : 'UNCERTAIN',
      reasons,
    };
  }
  finish(
    state: PaperPortfolioState,
    last: EquitySnapshot,
    dataset: StoredDataset,
  ): BacktestMetrics {
    const closed = state.positions.filter(
      (position) => position.status === 'CLOSED',
    );
    const wins = closed.filter(
        (position) => signed(position.realizedPnlUsd) > 0n,
      ),
      losses = closed.filter(
        (position) => signed(position.realizedPnlUsd) < 0n,
      );
    const sum = (positions: typeof closed) =>
      positions.reduce(
        (total, position) => total + signed(position.realizedPnlUsd),
        0n,
      );
    const averagePnl = (positions: typeof closed) =>
      positions.length
        ? fromAtomic(sum(positions) / BigInt(positions.length))
        : null;
    const returnOf = (position: (typeof closed)[number]) =>
      (signed(position.realizedPnlUsd) * HUNDRED) /
      toAtomic(position.initialCostBasisUsd);
    const averageReturn = (positions: typeof closed) =>
      positions.length
        ? fromAtomic(
            positions.reduce(
              (total, position) => total + returnOf(position),
              0n,
            ) / BigInt(positions.length),
          )
        : null;
    const ordered = [...closed].sort((a, b) => {
      const delta =
        signed(a.realizedPnlUsd) * toAtomic(b.initialCostBasisUsd) -
        signed(b.realizedPnlUsd) * toAtomic(a.initialCostBasisUsd);
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    });
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length
      ? fromAtomic(
          ordered.length % 2
            ? returnOf(ordered[middle]!)
            : (returnOf(ordered[middle - 1]!) + returnOf(ordered[middle]!)) /
                2n,
        )
      : null;
    const maximum = wins.reduce<bigint | null>(
      (best, position) =>
        best === null || signed(position.realizedPnlUsd) > best
          ? signed(position.realizedPnlUsd)
          : best,
      null,
    );
    const minimum = losses.reduce<bigint | null>(
      (best, position) =>
        best === null || signed(position.realizedPnlUsd) < best
          ? signed(position.realizedPnlUsd)
          : best,
      null,
    );
    const initial = toAtomic(this.plan.paper.initialBalanceUsd),
      finalEquity =
        last.totalEquityUsd === null ? null : toAtomic(last.totalEquityUsd);
    const open = state.positions.filter(
      (position) => position.status !== 'CLOSED',
    );
    return {
      portfolio: {
        startingBalanceUsd: this.plan.paper.initialBalanceUsd,
        endingCashUsd: state.availableCashUsd,
        endingMarkedEquityUsd: last.totalEquityUsd,
        realizedNetPnlUsd: state.realizedPnlUsd,
        unrealizedPnlUsd: last.unrealizedPnlUsd,
        totalNetReturnPercent:
          finalEquity === null
            ? null
            : percentage(finalEquity - initial, initial),
        peakReliableEquityUsd: fromAtomic(this.peak),
        maximumDrawdownPercent: percentage(this.maximumDrop, this.peakAtDrop),
        drawdownCoverageComplete: this.uncertainSnapshots === 0,
        buyFeesUsd: state.buyFeesUsd,
        sellFeesUsd: state.sellFeesUsd,
        totalFeesUsd: fromAtomic(
          toAtomic(state.buyFeesUsd) + toAtomic(state.sellFeesUsd),
        ),
        simulatedSlippageUsd: fromAtomic(this.slippage),
      },
      trading: {
        entryOrders: this.entryOrders,
        exitOrders: this.exitOrders,
        filledOrders: this.filledOrders,
        failedOrders: this.failedOrders,
        closedPositions: closed.length,
        winningClosedPositions: wins.length,
        losingClosedPositions: losses.length,
        breakEvenClosedPositions: closed.length - wins.length - losses.length,
        winRatePercent: closed.length
          ? fromAtomic((BigInt(wins.length) * HUNDRED) / BigInt(closed.length))
          : null,
        averageWinningReturnPercent: averageReturn(wins),
        averageLosingReturnPercent: averageReturn(losses),
        averageWinningPnlUsd: averagePnl(wins),
        averageLosingPnlUsd: averagePnl(losses),
        expectancyUsd: averagePnl(closed),
        medianPositionReturnPercent: median,
        largestWinningPositionUsd:
          maximum === null ? null : fromAtomic(maximum),
        largestLosingPositionUsd: minimum === null ? null : fromAtomic(minimum),
        profitFactor: losses.length
          ? {
              value: fromAtomic((sum(wins) * SCALE) / -sum(losses)),
              reason: null,
            }
          : {
              value: null,
              reason: closed.length
                ? 'NO_LOSING_CLOSED_POSITIONS'
                : 'NO_CLOSED_POSITIONS',
            },
        averageHoldingSeconds: closed.length
          ? fromAtomic(
              (BigInt(
                closed.reduce(
                  (total, position) =>
                    total +
                    Date.parse(position.closedAt!) -
                    Date.parse(position.openedAt),
                  0,
                ),
              ) *
                SCALE) /
                (BigInt(closed.length) * 1000n),
            )
          : null,
        maximumConcurrentPositions: this.maxConcurrent,
      },
      strategy: {
        tokensEvaluated: this.tokens.size,
        evaluations: this.evaluations,
        tokensBlockedByRisk: this.blockedTokens.size,
        riskBlockedDecisions: this.riskBlocked,
        signalsGenerated: this.signals,
        entriesRejected: this.rejected,
        signalsRejectedByPortfolioRisk: this.rejectedByRisk,
        signalsWithoutExecutionObservations: this.missingExecution,
        positionsOpened: this.opened,
        positionsClosed: closed.length,
        positionsRemainingOpen: open.length,
        stopLossExits: this.stopExits,
        takeProfitExits: this.tpExits,
        trailingStopExits: this.trailExits,
        timeBasedExits: this.timeExits,
        failedExitAttempts: this.failedExits,
      },
      dataQuality: {
        missingHistoricalIntervals: dataset.quality.missingHistoricalIntervals,
        stalePriceObservations: this.stalePrices,
        unknownSecurityAssessments: this.unknownRisk,
        insufficientHistoryDecisions: this.insufficientHistory,
        unpricedOpenPositions: open.filter(
          (position) =>
            !position.mark ||
            position.valuationStale ||
            position.liquidationUncertain,
        ).length,
        executionObservationsUnavailable: this.unavailable,
        uncertainEquitySnapshots: this.uncertainSnapshots,
      },
      baseline: {
        startingBalanceUsd: this.plan.paper.initialBalanceUsd,
        endingEquityUsd: this.plan.paper.initialBalanceUsd,
        netReturnPercent: '0',
        feesUsd: '0',
        trades: 0,
        strategyMinusBaselineUsd:
          finalEquity === null ? null : fromAtomic(finalEquity - initial),
      },
    };
  }
}
