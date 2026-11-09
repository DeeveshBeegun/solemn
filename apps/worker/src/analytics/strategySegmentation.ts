import { fromAtomic, toAtomic } from '@solemn/shared';
import type { PaperPosition } from '@solemn/shared';
import { closedPositionMetrics } from './closedPositionMetrics.js';
import type { analyzePerformance } from './performance.js';
import type { SignalRow } from './signalAnalyzer.js';

type TradeRow = ReturnType<typeof analyzePerformance>['tradeRows'][number];
const band = (value: string | null, bounds: readonly string[]) => {
  if (value === null) return 'UNKNOWN';
  // Ratio features can exceed the ledger's USD string bounds. Compare their integer component first.
  if (value.startsWith('-')) return `<${bounds[0]}`;
  if (value.split('.')[0]!.length > 60) return `>=${bounds.at(-1)}`;
  const atomic = toAtomic(value),
    index = bounds.findIndex((b) => atomic < toAtomic(b));
  return index === 0
    ? `<${bounds[0]}`
    : index < 0
      ? `>=${bounds.at(-1)}`
      : `[${bounds[index - 1]},${bounds[index]})`;
};
export function segmentPositions(
  trades: readonly TradeRow[],
  signals: readonly SignalRow[],
  positions: readonly PaperPosition[],
  strategyVersion: string,
) {
  const signal = new Map(signals.map((s) => [s.signalId, s.features])),
    byId = new Map(positions.map((p) => [p.id, p]));
  const groups = new Map<
    string,
    { dimension: string; band: string; trades: TradeRow[] }
  >();
  for (const t of trades) {
    const f = signal.get(t.signalId);
    const dimensions: Record<string, string> = {
      mint: t.mint,
      strategyVersion,
      venue: t.venue,
      openDate: t.openedAt.slice(0, 10),
      holdingSeconds: band(String(t.holdingSeconds), ['60', '300', '1800']),
      positionSizeUsd: band(t.initialCostBasisUsd, ['0.5', '1', '5']),
      liquidityUsd: band(f?.liquidityUsd ?? null, ['10000', '50000', '250000']),
      poolAgeMinutes: band(f?.poolAgeMinutes ?? null, ['5', '15', '60']),
      volumeAcceleration: band(f?.volumeAcceleration ?? null, ['2', '4', '8']),
      buySellRatio: band(f?.buySellRatio ?? null, ['1', '2', '4']),
      volatility5mPercent: band(f?.volatility5mPercent ?? null, [
        '10',
        '25',
        '50',
      ]),
      uniqueBuyers5m: band(
        f?.uniqueBuyers5m === null || f?.uniqueBuyers5m === undefined
          ? null
          : String(f.uniqueBuyers5m),
        ['10', '20', '50'],
      ),
      momentum5mPercent: band(f?.momentum5mPercent ?? null, ['10', '30', '60']),
      pullbackPercent: band(f?.pullbackPercent ?? null, ['10', '25', '50']),
      breakoutStrengthPercent: band(f?.breakoutStrengthPercent ?? null, [
        '5',
        '15',
        '30',
      ]),
      entryImpactBps: band(t.entryImpactBps, ['5', '50', '200']),
      executionCostUsd: band(t.costsComplete ? t.identifiedCostsUsd : null, [
        '0.005',
        '0.02',
        '0.05',
      ]),
    };
    for (const [dimension, key] of Object.entries(dimensions)) {
      const id = `${dimension}:${key}`,
        group = groups.get(id) ?? { dimension, band: key, trades: [] };
      group.trades.push(t);
      groups.set(id, group);
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.dimension.localeCompare(b.dimension) || a.band.localeCompare(b.band),
    )
    .map((g) => {
      const closed = g.trades
        .filter((t) => t.status === 'CLOSED')
        .map((t) => byId.get(t.positionId)!);
      const stats = closedPositionMetrics(closed),
        totalCosts = g.trades.reduce(
          (sum, t) => sum + toAtomic(t.identifiedCostsUsd),
          0n,
        );
      return {
        dimension: g.dimension,
        band: g.band,
        positions: g.trades.length,
        completedPositions: stats.closedPositions,
        netClosedPnlUsd: stats.closedNetPnlUsd,
        averageReturnPercent: stats.meanReturnPercent,
        medianReturnPercent: stats.medianPositionReturnPercent,
        winRatePercent: stats.winRatePercent,
        profitFactor: stats.profitFactor.value,
        maximumObservedDrawdownPercent: null,
        averageIdentifiedCostUsd: fromAtomic(
          totalCosts / BigInt(g.trades.length),
        ),
        costCoverageComplete: g.trades.every((t) => t.costsComplete),
        unresolvedPositions: g.trades.length - closed.length,
        unresolvedBasisUsd: fromAtomic(
          g.trades.reduce((sum, t) => sum + toAtomic(t.remainingBasisUsd), 0n),
        ),
        interpretation: 'EXPLORATORY',
      };
    });
}
