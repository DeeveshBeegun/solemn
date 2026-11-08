import { toAtomic } from '@solemn/shared';
import type {
  JupiterObservation,
  RiskPolicy,
  TokenRiskAssessment,
} from '@solemn/shared';

export function isFresh(
  timestamp: string | null,
  now: string,
  maxAgeSeconds: number,
): boolean {
  if (timestamp === null) return false;
  const age = Date.parse(now) - Date.parse(timestamp);
  return Number.isFinite(age) && age >= 0 && age < maxAgeSeconds * 1000;
}

export function analyzeLiquidity(
  observation: JupiterObservation,
  policy: RiskPolicy,
  now: string,
  previous: TokenRiskAssessment | null = null,
) {
  const fresh =
    observation.state === 'OK' &&
    isFresh(observation.fetchedAt, now, policy.maxDataAgeSeconds) &&
    isFresh(observation.updatedAt, now, policy.maxDataAgeSeconds);
  const available = fresh && observation.liquidityUsd !== null;
  const belowMinimum = available
    ? toAtomic(observation.liquidityUsd as string) <
      toAtomic(policy.minLiquidityUsd)
    : null;
  const prior = previous?.evidence.jupiter;
  const priorUsable =
    prior?.state === 'OK' &&
    prior.liquidityUsd !== null &&
    isFresh(prior.fetchedAt, now, policy.maxDataAgeSeconds) &&
    isFresh(prior.updatedAt, now, policy.maxDataAgeSeconds);
  let deteriorated: boolean | null = null;
  if (
    available &&
    priorUsable &&
    prior &&
    toAtomic(prior.liquidityUsd as string) > 0n &&
    Date.parse(observation.updatedAt as string) >=
      Date.parse(prior.updatedAt as string)
  ) {
    const hundred = toAtomic('100');
    deteriorated =
      toAtomic(observation.liquidityUsd as string) * hundred <
      toAtomic(prior.liquidityUsd as string) *
        (hundred - toAtomic(policy.maxLiquidityDropPercentage));
  }
  return {
    fresh,
    available,
    belowMinimum,
    deteriorated,
    previousLiquidityUsd: priorUsable ? (prior?.liquidityUsd ?? null) : null,
  };
}
