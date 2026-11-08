import { toAtomic } from '@solemn/shared';
import type { JupiterObservation, RiskPolicy } from '@solemn/shared';
import { isFresh } from './liquidityAnalyzer.js';

export function analyzeHolders(
  observation: JupiterObservation,
  policy: RiskPolicy,
  now: string,
) {
  const available =
    observation.state === 'OK' &&
    observation.topHoldersPercentage !== null &&
    isFresh(observation.updatedAt, now, policy.maxDataAgeSeconds) &&
    isFresh(observation.fetchedAt, now, policy.maxDataAgeSeconds);
  return {
    available,
    aboveMaximum: available
      ? toAtomic(observation.topHoldersPercentage as string) >
        toAtomic(policy.maxTopHoldersPercentage)
      : null,
    holderCount: observation.holderCount,
    metric: 'JUPITER_TOP_HOLDERS_PERCENTAGE' as const,
  };
}
