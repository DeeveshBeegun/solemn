import { fromAtomic, toAtomic } from '@solemn/shared';
import { percentage } from '../portfolio/decimal.js';
import type { EquityPoint } from './contracts.js';

export function analyzeDrawdown(
  points: readonly EquityPoint[],
  cadence: { startTime: string; equityCadenceMs: number } | null,
  start: string,
  end: string,
) {
  const ordered = [...points].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  let peak: bigint | null = null,
    peakAt: string | null = null,
    relativePeak: bigint | null = null,
    relativeDrop = 0n,
    absoluteDrop = 0n,
    relativeAt: string | null = null,
    relativePeakAt: string | null = null,
    absoluteAt: string | null = null,
    current: bigint | null = null;
  let uncertain = 0,
    largestGapMs = 0,
    priorTime: number | null = null;
  const uncertainIntervals: { from: string; to: string }[] = [];
  let openInterval: string | null = null;
  for (const p of ordered) {
    const t = Date.parse(p.at);
    if (priorTime !== null)
      largestGapMs = Math.max(largestGapMs, t - priorTime);
    priorTime = t;
    if (p.equityUsd === null) {
      uncertain++;
      current = null;
      openInterval ??= p.at;
      continue;
    }
    if (openInterval) {
      uncertainIntervals.push({ from: openInterval, to: p.at });
      openInterval = null;
    }
    current = toAtomic(p.equityUsd);
    if (peak === null || current > peak) {
      peak = current;
      peakAt = p.at;
    }
    const drop = peak - current;
    if (drop > absoluteDrop) {
      absoluteDrop = drop;
      absoluteAt = p.at;
    }
    if (
      peak > 0n &&
      (relativePeak === null || drop * relativePeak > relativeDrop * peak)
    ) {
      relativePeak = peak;
      relativeDrop = drop;
      relativeAt = p.at;
      relativePeakAt = peakAt;
    }
  }
  if (openInterval) uncertainIntervals.push({ from: openInterval, to: end });
  let missingScheduledSnapshots: number | null = null;
  if (cadence) {
    const origin = Date.parse(cadence.startTime),
      ms = cadence.equityCadenceMs;
    const first = Math.max(0, Math.ceil((Date.parse(start) - origin) / ms)),
      last = Math.floor((Date.parse(end) - origin) / ms);
    const observed = new Set(
      ordered
        .filter(
          (p) =>
            p.reason !== 'BOUNDARY_FROM_LEDGER' &&
            p.reason !== 'UNCERTAIN_LEDGER_VALUATION' &&
            p.reason !== 'RECONCILED_LEDGER_MARK',
        )
        .map((p) => Date.parse(p.at))
        .filter(
          (t) =>
            t >= origin + first * ms &&
            t <= origin + last * ms &&
            (t - origin) % ms === 0,
        ),
    );
    missingScheduledSnapshots = Math.max(0, last - first + 1 - observed.size);
  }
  return {
    peakEquityUsd: peak === null ? null : fromAtomic(peak),
    currentDrawdownUsd:
      peak === null || current === null ? null : fromAtomic(peak - current),
    currentDrawdownPercent:
      peak === null || peak === 0n || current === null
        ? null
        : percentage(peak - current, peak),
    maximumObservedDrawdownUsd: peak === null ? null : fromAtomic(absoluteDrop),
    maximumObservedDrawdownUsdAt: absoluteAt,
    maximumObservedDrawdownPercent:
      relativePeak === null ? null : percentage(relativeDrop, relativePeak),
    maximumObservedDrawdownAt: relativeAt,
    maximumObservedDrawdownPeakAt: relativePeakAt,
    uncertainSnapshots: uncertain,
    uncertainIntervals,
    missingScheduledSnapshots,
    largestSnapshotGapMs: ordered.length >= 2 ? largestGapMs : null,
    coverageComplete:
      ordered.length >= 2 && uncertain === 0 && missingScheduledSnapshots === 0,
  };
}
