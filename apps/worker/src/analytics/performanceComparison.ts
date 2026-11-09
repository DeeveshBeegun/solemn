import { fromAtomic, toAtomic } from '@solemn/shared';
import { SCALE } from '../portfolio/decimal.js';
import type { Evaluation } from './strategyEvaluator.js';

export function compareEvaluations(
  primary: Evaluation | null,
  reference: Evaluation | null,
) {
  const describe = (e: Evaluation | null) => {
    if (!e) return null;
    const p = e.provenance,
      t = e.trading,
      c = e.costs;
    return {
      provenance: p,
      signals: e.signalFunnel.buyCandidates,
      signalsPerHour: p.durationMs
        ? fromAtomic(
            (BigInt(e.signalFunnel.buyCandidates) * 3600000n * SCALE) /
              BigInt(p.durationMs),
          )
        : null,
      entryFillRatePercent: t.entryFillRatePercent,
      exitFillRatePercent: t.exitFillRatePercent,
      averageIdentifiedCostPerOrderUsd: c.orders
        ? fromAtomic(toAtomic(c.totalIdentifiedCostsUsd) / BigInt(c.orders))
        : null,
      costCoverageComplete: c.complete,
      averageSimulatedLatencyMs: c.averageSimulatedLatencyMs,
      providerProcessingLatencyMs: e.quality.providerProcessingLatencyMs,
      averageHoldingSeconds: t.averageHoldingSeconds,
      realizedNetPnlUsd: e.portfolio.realizedNetPnlUsd,
      netReturnPercent: e.portfolio.netReturnPercent,
      winRatePercent: t.winRatePercent,
      averageWinningPnlUsd: t.averageWinningPnlUsd,
      averageLosingPnlUsd: t.averageLosingPnlUsd,
      expectancyUsd: t.expectancyUsd,
      profitFactor: t.profitFactor,
      maximumObservedDrawdownPercent:
        e.portfolio.maximumObservedDrawdownPercent,
      drawdownCoverageComplete: e.portfolio.coverageComplete,
      marketGaps: e.quality.window.marketGaps,
      unresolvedPositions: t.openPositions,
      quality: e.quality.status,
      sample: t.closedPositions,
      status: e.status,
    };
  };
  const reasons: string[] = [];
  if (!primary || !reference) reasons.push('MISSING_COMPARISON_SOURCE');
  if (primary && reference) {
    const a = primary.provenance,
      b = reference.provenance;
    if (
      ![a.source, b.source].includes('historical') ||
      ![a.source, b.source].includes('forward')
    )
      reasons.push('SOURCES_ARE_NOT_EMPIRICAL_HISTORICAL_AND_FORWARD');
    if (a.strategyId !== b.strategyId || a.strategyHash !== b.strategyHash)
      reasons.push('STRATEGY_CONFIGURATION_DIFFERS');
    if (a.configurationHash !== b.configurationHash)
      reasons.push('RISK_PAPER_EXECUTION_OR_TIMING_DIFFERS');
    if (
      primary.status === 'INSUFFICIENT_DATA' ||
      reference.status === 'INSUFFICIENT_DATA'
    )
      reasons.push('EVIDENCE_INSUFFICIENT');
    if (
      primary.quality.status !== 'READY' ||
      reference.quality.status !== 'READY'
    )
      reasons.push('DATA_QUALITY_INCOMPLETE');
  }
  return {
    status: reasons.length ? 'NON_COMPARABLE' : 'COMPARABLE_DESCRIPTIVE',
    reasons,
    primary: describe(primary),
    reference: describe(reference),
    limitations: [
      'MARKET_REGIME_AND_PROVIDER_LATENCY_NOT_MATCHED',
      'PERIODS_AND_LIQUIDITY_CONDITIONS_CAN_DIFFER',
      'NO_CAUSAL_INFERENCE',
    ],
  };
}
