import { fromAtomic, toAtomic } from '@solemn/shared';
import type { PaperPosition } from '@solemn/shared';
import { HUNDRED, percentage, signed } from '../portfolio/decimal.js';
import { closedPositionMetrics } from './closedPositionMetrics.js';

export function statisticalValidation(
  closed: readonly PaperPosition[],
  start: string,
  end: string,
) {
  const stats = closedPositionMetrics(closed),
    n = closed.length;
  const winners = closed
    .filter((p) => signed(p.realizedPnlUsd) > 0n)
    .sort((a, b) => {
      const diff = signed(b.realizedPnlUsd) - signed(a.realizedPnlUsd);
      return diff === 0n ? a.id.localeCompare(b.id) : diff > 0n ? 1 : -1;
    });
  const winnerSum = winners.reduce(
    (sum, p) => sum + signed(p.realizedPnlUsd),
    0n,
  );
  const sensitivity = (count: number) => {
    if (winners.length < count || n <= count) return null;
    const removed = winners.slice(0, count),
      ids = new Set(removed.map((p) => p.id));
    const retained = closedPositionMetrics(
      closed.filter((p) => !ids.has(p.id)),
    );
    return {
      removedPositionIds: removed.map((p) => p.id),
      remainingPositions: retained.closedPositions,
      remainingClosedNetPnlUsd: retained.closedNetPnlUsd,
      remainingExpectancyUsd: retained.expectancyUsd,
      remainingMeanReturnPercent: retained.meanReturnPercent,
      remainingProfitFactor: retained.profitFactor,
      signChanged:
        stats.closedNetPnlUsd !== '0' &&
        !stats.closedNetPnlUsd.startsWith('-') &&
        (retained.closedNetPnlUsd === '0' ||
          retained.closedNetPnlUsd.startsWith('-')),
    };
  };
  const returns = closed.map(
    (p) =>
      (signed(p.realizedPnlUsd) * HUNDRED) / toAtomic(p.initialCostBasisUsd),
  );
  const average = n
    ? returns.reduce((sum, value) => sum + value, 0n) / BigInt(n)
    : 0n;
  const dispersion = returns.reduce((sum, value) => {
    const deviation = value - average;
    return sum + (deviation < 0n ? -deviation : deviation);
  }, 0n);
  const midpoint = new Date(
    Date.parse(start) + Math.floor((Date.parse(end) - Date.parse(start)) / 2),
  ).toISOString();
  let longestLossStreak = 0,
    currentLossStreak = 0;
  for (const p of [...closed].sort(
    (a, b) =>
      Date.parse(a.closedAt!) - Date.parse(b.closedAt!) ||
      a.id.localeCompare(b.id),
  )) {
    currentLossStreak =
      signed(p.realizedPnlUsd) < 0n ? currentLossStreak + 1 : 0;
    longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
  }
  const dates = [
    ...new Set(closed.map((p) => p.closedAt!.slice(0, 10))),
  ].sort();
  return {
    completedPositions: n,
    longestLossStreak,
    distinctTokens: new Set(closed.map((p) => p.mint)).size,
    distinctCloseDates: dates.length,
    meanReturnPercent: stats.meanReturnPercent,
    medianReturnPercent: stats.medianPositionReturnPercent,
    meanAbsoluteDeviationPercent:
      n > 1 ? fromAtomic(dispersion / BigInt(n)) : null,
    topWinnerShareOfGrossWinsPercent: winnerSum
      ? percentage(signed(winners[0]!.realizedPnlUsd), winnerSum)
      : null,
    topThreeShareOfGrossWinsPercent:
      winners.length >= 3
        ? percentage(
            winners
              .slice(0, 3)
              .reduce((sum, p) => sum + signed(p.realizedPnlUsd), 0n),
            winnerSum,
          )
        : null,
    withoutLargestWinner: sensitivity(1),
    withoutThreeLargestWinners: sensitivity(3),
    chronological: [
      {
        label: 'FIRST_HALF',
        start,
        end: midpoint,
        ...closedPositionMetrics(
          closed.filter((p) => Date.parse(p.closedAt!) < Date.parse(midpoint)),
        ),
      },
      {
        label: 'SECOND_HALF',
        start: midpoint,
        end,
        ...closedPositionMetrics(
          closed.filter((p) => Date.parse(p.closedAt!) >= Date.parse(midpoint)),
        ),
      },
    ],
    uncertaintyMethod: 'DESCRIPTIVE_ONLY',
    sampleLimited:
      n < 10 || dates.length < 2 || new Set(closed.map((p) => p.mint)).size < 3,
  };
}
