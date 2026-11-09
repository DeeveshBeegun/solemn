import { closedPositionMetrics } from '../analytics/closedPositionMetrics.js';
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
import { SCALE, percentage } from '../portfolio/decimal.js';
export class PerformanceAnalyzer {
  private attempts = 0;
  private outcomes: Record<string, number> = {};
  private latencySamples: number[] = [];
  private impactTotal = 0n;
  private impactMax = 0n;
  private impactCount = 0;
  private feeCategories: Record<string, bigint> = {};
  private failedFees = 0n;
  private unknownLamports = 0n;
  private slippageFailures = 0;
  private filledEntries = 0;
  private filledExits = 0;
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
  constructor(
    readonly plan: Pick<
      BacktestPlan,
      'paper' | 'runId' | 'execution' | 'maxEvents'
    >,
  ) {
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
      if (record.audit) {
        const audit = record.audit;
        this.attempts++;
        this.outcomes[audit.outcome] = (this.outcomes[audit.outcome] ?? 0) + 1;
        if (this.latencySamples.length >= this.plan.maxEvents)
          throw new Error('Execution metrics capacity exceeded');
        this.latencySamples.push(audit.latencyMs);
        if (audit.outcome === 'FILLED') {
          if (record.order.side === 'BUY') this.filledEntries++;
          else this.filledExits++;
          if (audit.impactBps !== null) {
            const n = toAtomic(audit.impactBps);
            this.impactTotal += n;
            this.impactMax = n > this.impactMax ? n : this.impactMax;
            this.impactCount++;
          }
        }
        for (const fee of audit.fees)
          if (fee.usd !== null)
            this.feeCategories[fee.category] =
              (this.feeCategories[fee.category] ?? 0n) + toAtomic(fee.usd);
        if (audit.outcome === 'FAILED_ON_CHAIN')
          this.failedFees += toAtomic(audit.networkFeeUsd);
        this.unknownLamports += BigInt(audit.unpricedFeeLamports);
        if (audit.reason === 'SLIPPAGE_TOLERANCE_EXCEEDED')
          this.slippageFailures++;
      }
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
    if (state.executionUncertain)
      reasons.push('EXECUTION_OR_NATIVE_FEE_UNCERTAIN');
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
    dataset: {
      quality: Pick<
        StoredDataset['quality'],
        'missingHistoricalIntervals' | 'readiness'
      >;
    },
  ): BacktestMetrics {
    const closed = state.positions.filter(
      (position) => position.status === 'CLOSED',
    );
    const { closedNetPnlUsd, meanReturnPercent, ...closedMetrics } =
      closedPositionMetrics(closed);
    void closedNetPnlUsd;
    void meanReturnPercent;
    const initial = toAtomic(this.plan.paper.initialBalanceUsd),
      finalEquity =
        last.totalEquityUsd === null ? null : toAtomic(last.totalEquityUsd);
    const open = state.positions.filter(
      (position) => position.status !== 'CLOSED',
    );
    const latencies = this.latencySamples.sort((a, b) => a - b),
      mid = Math.floor(latencies.length / 2);
    const knownFees = Object.values(this.feeCategories).reduce(
      (sum, n) => sum + n,
      0n,
    );
    return {
      ...(this.plan.execution
        ? {
            execution: {
              attempts: this.attempts,
              outcomes: this.outcomes,
              fillRatePercent: this.attempts
                ? percentage(
                    BigInt(this.outcomes.FILLED ?? 0),
                    BigInt(this.attempts),
                  )
                : null,
              entryFillRatePercent: this.entryOrders
                ? percentage(
                    BigInt(this.filledEntries),
                    BigInt(this.entryOrders),
                  )
                : null,
              exitFillRatePercent: this.exitOrders
                ? percentage(BigInt(this.filledExits), BigInt(this.exitOrders))
                : null,
              averageLatencyMs: latencies.length
                ? fromAtomic(
                    (BigInt(latencies.reduce((s, n) => s + n, 0)) * SCALE) /
                      BigInt(latencies.length),
                  )
                : null,
              medianLatencyMs: latencies.length
                ? fromAtomic(
                    latencies.length % 2
                      ? BigInt(latencies[mid]!) * SCALE
                      : (BigInt(latencies[mid - 1]! + latencies[mid]!) *
                          SCALE) /
                          2n,
                  )
                : null,
              averageImpactBps: this.impactCount
                ? fromAtomic(this.impactTotal / BigInt(this.impactCount))
                : null,
              maximumImpactBps: this.impactCount
                ? fromAtomic(this.impactMax)
                : null,
              slippageFailures: this.slippageFailures,
              knownFeesUsd: fromAtomic(knownFees),
              failedTransactionFeesUsd: fromAtomic(this.failedFees),
              feesByCategoryUsd: Object.fromEntries(
                Object.entries(this.feeCategories).map(([key, n]) => [
                  key,
                  fromAtomic(n),
                ]),
              ),
              unknownFeeLamports: this.unknownLamports.toString(),
              netUsdComplete:
                !state.executionUncertain && last.totalEquityUsd !== null,
              netRealizedPnlUsd: state.executionUncertain
                ? null
                : state.realizedPnlUsd,
            },
          }
        : {}),
      portfolio: {
        startingBalanceUsd: this.plan.paper.initialBalanceUsd,
        endingCashUsd: state.availableCashUsd,
        endingMarkedEquityUsd: last.totalEquityUsd,
        realizedNetPnlUsd: state.executionUncertain
          ? null
          : state.realizedPnlUsd,
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
        totalFeesUsd: state.executionUncertain
          ? null
          : fromAtomic(
              toAtomic(state.buyFeesUsd) + toAtomic(state.sellFeesUsd),
            ),
        simulatedSlippageUsd: fromAtomic(this.slippage),
      },
      trading: {
        entryOrders: this.entryOrders,
        exitOrders: this.exitOrders,
        filledOrders: this.filledOrders,
        failedOrders: this.failedOrders,
        ...closedMetrics,
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
