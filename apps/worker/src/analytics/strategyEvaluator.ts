import { stableHash, toAtomic } from '@solemn/shared';
import type { CapturedPortfolio } from './contracts.js';
import { signed, percentage } from '../portfolio/decimal.js';
import { analyzePerformance } from './performance.js';
import { analyzeSignals } from './signalAnalyzer.js';
import { statisticalValidation } from './statisticalValidation.js';
import { segmentPositions } from './strategySegmentation.js';
import { observationCounts } from './readEvaluation.js';

export function evaluateStrategy(input: CapturedPortfolio) {
  const performance = analyzePerformance(input),
    signals = analyzeSignals(input),
    { portfolio, trading, costs } = performance;
  const stats = statisticalValidation(
    performance.closed,
    input.start,
    input.end,
  );
  const segments = segmentPositions(
    performance.tradeRows,
    signals.rows,
    input.endState.positions,
    input.definition.strategyPolicy.version,
  );
  const critical: string[] = [],
    limitations: string[] = [];
  if (input.source === 'forward' && (!input.execution || !trading.filledOrders))
    critical.push('LIVE_FORWARD_EXECUTION_EVIDENCE_UNAVAILABLE');
  if (input.quality?.readiness === 'INSUFFICIENT')
    critical.push('SOURCE_DATA_INSUFFICIENT');
  if (input.quality?.missingHistoricalIntervals)
    critical.push('STORED_RUN_AUDIT_REPORTS_MISSING_INTERVALS');
  if (input.quality?.uncertainOrderingGroups)
    critical.push('STORED_RUN_AUDIT_REPORTS_UNCERTAIN_EVENT_ORDERING');
  if ((input.observations.marketGaps ?? 0) > 0)
    critical.push('MARKET_DATA_GAPS');
  if (
    portfolio.endingMarkedEquityUsd === null ||
    portfolio.openingMarkedEquityUsd === null
  )
    critical.push('BOUNDARY_EQUITY_UNKNOWN');
  if (
    costs.unknownFeeOrders ||
    costs.legacyOrders ||
    input.endState.executionUncertain
  )
    critical.push('EXECUTION_COST_COVERAGE_INCOMPLETE');
  if (portfolio.missingScheduledSnapshots)
    critical.push('MISSING_SCHEDULED_EQUITY_SNAPSHOTS');
  if (portfolio.uncertainSnapshots)
    limitations.push('OBSERVED_DRAWDOWN_COVERS_RELIABLE_MARKS_ONLY');
  if (portfolio.missingScheduledSnapshots === null)
    limitations.push('STORED_SOURCE_CADENCE_UNAVAILABLE');
  if (performance.tradeRows.some((p) => p.carryIn))
    limitations.push(
      'CLOSED_POSITION_STATISTICS_INCLUDE_LIFETIME_OUTCOMES_FOR_CARRY_INS',
    );
  if (input.observations.observationCount === null)
    limitations.push('RAW_WINDOW_OBSERVATION_COUNTS_UNAVAILABLE');
  if (!input.registration) limitations.push('RETROSPECTIVE_PERIOD_SELECTION');
  limitations.push('DESCRIPTIVE_STATISTICS_WITHOUT_INDEPENDENCE_ASSUMPTIONS');
  const evidence: string[] = [];
  if (!['historical', 'forward'].includes(input.source))
    evidence.push('SYNTHETIC_OR_REPLAY_SOURCE');
  if (stats.sampleLimited)
    evidence.push('LIMITED_COMPLETED_POSITIONS_TOKENS_OR_DATES');
  const realized =
      portfolio.realizedNetPnlUsd === null
        ? null
        : signed(input.endState.realizedPnlUsd) -
          signed(input.startState.realizedPnlUsd),
    marked =
      portfolio.netMarkedPnlUsd === null
        ? null
        : signed(portfolio.netMarkedPnlUsd);
  const status =
    critical.length || evidence.length || marked === null || realized === null
      ? 'INSUFFICIENT_DATA'
      : marked < 0n || realized < 0n
        ? 'UNDERPERFORMING'
        : marked > 0n &&
            realized > 0n &&
            (stats.withoutLargestWinner === null ||
              (stats.withoutLargestWinner.remainingClosedNetPnlUsd !== '0' &&
                !stats.withoutLargestWinner.remainingClosedNetPnlUsd.startsWith(
                  '-',
                )))
          ? 'PROMISING_BUT_INCONCLUSIVE'
          : 'FURTHER_VALIDATION_REQUIRED';
  const quality = {
    status: critical.length
      ? 'INSUFFICIENT_DATA'
      : limitations.some(
            (l) => l.includes('UNAVAILABLE') || l.includes('RELIABLE_MARKS'),
          )
        ? 'DEGRADED'
        : 'READY',
    critical,
    limitations,
    window: observationCounts(input.observations),
    storedFullRunAudit: input.quality,
    uncertainEquityIntervals: portfolio.uncertainIntervals,
    missingScheduledSnapshots: portfolio.missingScheduledSnapshots,
    unknownCostOrders: costs.unknownFeeOrders + costs.legacyOrders,
    unpricedPositions: portfolio.unpricedPositions,
    unverifiableExecutions: trading.unverifiableExecutions,
    staleExecutionDecisions: input.journal.filter(
      (e) => e.result.outcome === 'STALE_DATA' && e.command?.type === 'MARK',
    ).length,
    duplicateEventRatePercent:
      input.observations.duplicates !== null &&
      input.observations.observationCount !== null &&
      input.observations.observationCount + input.observations.duplicates > 0
        ? percentage(
            BigInt(input.observations.duplicates),
            BigInt(
              input.observations.observationCount +
                input.observations.duplicates,
            ),
          )
        : null,
    providerProcessingLatencyMs: null,
  };
  const findings: {
    hypothesis: string;
    sample: number;
    evidence: Record<string, unknown>;
    proposedChange: string;
    overfittingRisk: string;
    futureTest: string;
  }[] = [];
  if (
    stats.topWinnerShareOfGrossWinsPercent &&
    toAtomic(stats.topWinnerShareOfGrossWinsPercent) >= toAtomic('50')
  )
    findings.push({
      hypothesis: 'A rare winner may dominate the closed-position result',
      sample: stats.completedPositions,
      evidence: {
        topWinnerShareOfGrossWinsPercent:
          stats.topWinnerShareOfGrossWinsPercent,
        withoutLargestWinner: stats.withoutLargestWinner,
      },
      proposedChange:
        'Evaluate exit sizing and holding assumptions in a separate versioned experiment',
      overfittingRisk:
        'High because the largest winner was identified retrospectively',
      futureTest:
        'Freeze two exit policies before collecting an independent chronological sample',
    });
  if (trading.blockedExits || trading.failedExits)
    findings.push({
      hypothesis:
        'Executable exit depth may limit protection during adverse moves',
      sample: trading.exitOrders,
      evidence: {
        blockedPositions: trading.blockedExits,
        failedExitOrders: trading.failedExits,
        unpricedPositions: portfolio.unpricedPositions,
      },
      proposedChange:
        'Measure executable depth and transfer restrictions at entry and exit',
      overfittingRisk:
        'High because the affected exits may cluster in the same token or event',
      futureTest:
        'Collect verified pool states and compare predeclared depth bands across independent periods',
    });
  if (
    trading.openPositions === 0 &&
    !performance.tradeRows.some((t) => t.carryIn) &&
    realized !== null &&
    realized <= 0n &&
    realized + toAtomic(costs.bookedFeesUsd) > 0n
  )
    findings.push({
      hypothesis: 'Booked execution fees may consume modest gross gains',
      sample: costs.orders,
      evidence: {
        knownRealizedPnlUsd: portfolio.knownRealizedPnlUsd,
        bookedFeesUsd: costs.bookedFeesUsd,
      },
      proposedChange:
        'Test lower-cost execution assumptions in a separate scenario',
      overfittingRisk:
        'Costs vary with congestion, fee schedules and trade size',
      futureTest:
        'Use observed fee and latency evidence on a prospective sample with the same strategy',
    });
  const durationMs = Date.parse(input.end) - Date.parse(input.start);
  return {
    portfolio,
    trading,
    costs,
    signalFunnel: signals.funnel,
    statistics: stats,
    quality,
    status,
    evidenceReasons: [...critical, ...evidence],
    findings,
    rows: {
      trades: performance.tradeRows,
      signals: signals.rows,
      segments,
      equity: performance.curve,
    },
    provenance: {
      portfolioId: input.portfolioId,
      runId: input.runId,
      source: input.source,
      sourceId: input.sourceId,
      sourceFingerprint: input.sourceFingerprint,
      strategyId: input.strategyId,
      strategyVersion: input.definition.strategyPolicy.version,
      strategyHash: stableHash(input.definition.strategyPolicy),
      configurationHash: input.configurationHash,
      configuration: {
        strategy: input.definition.strategyPolicy,
        paper: input.definition.policy,
        risk: input.definition.riskPolicy,
        execution: input.execution,
      },
      riskVersion: input.definition.riskPolicy.version,
      executionVersion:
        input.execution?.modelVersion ??
        (input.source === 'forward' ? null : 'solemn-paper-v1'),
      start: input.start,
      end: input.end,
      periodType: input.periodType,
      registration: input.registration,
      periodSelection: input.registration ? 'PROSPECTIVE' : 'RETROSPECTIVE',
      durationMs,
    },
  };
}
export type Evaluation = ReturnType<typeof evaluateStrategy>;
