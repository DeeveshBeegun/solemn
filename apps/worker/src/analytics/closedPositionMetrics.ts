import { fromAtomic, toAtomic } from '@solemn/shared';
import type { PaperPosition } from '@solemn/shared';
import { HUNDRED, SCALE, signed } from '../portfolio/decimal.js';

export function closedPositionMetrics(closed: readonly PaperPosition[]) {
  const wins = closed.filter(
      (position) => signed(position.realizedPnlUsd) > 0n,
    ),
    losses = closed.filter((position) => signed(position.realizedPnlUsd) < 0n);
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
          : (returnOf(ordered[middle - 1]!) + returnOf(ordered[middle]!)) / 2n,
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
  return {
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
    largestWinningPositionUsd: maximum === null ? null : fromAtomic(maximum),
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
    closedNetPnlUsd: fromAtomic(sum(closed)),
    meanReturnPercent: averageReturn(closed),
  };
}
