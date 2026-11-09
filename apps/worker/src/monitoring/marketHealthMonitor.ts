import type { OperationalHealth } from '@solemn/database';

export function marketHealth(input: {
  connected: boolean;
  at: string;
  lastValidTrade: string | null;
  maxAgeSeconds: number;
  indicatorsReady: boolean;
  executableQuote: boolean;
  verified: boolean;
  queueDepth?: number;
  queueCapacity?: number;
  maxQueuePercent?: number;
}): Pick<OperationalHealth, 'market' | 'reason'> {
  if (!input.connected)
    return { market: 'DISCONNECTED', reason: 'MARKET_FEED_DISCONNECTED' };
  if (
    input.queueDepth !== undefined &&
    input.queueCapacity &&
    input.queueDepth * 100 >=
      input.queueCapacity * (input.maxQueuePercent ?? 80)
  )
    return { market: 'OVERLOADED', reason: 'MARKET_INGESTION_BACKLOG' };
  if (!input.verified)
    return { market: 'UNVERIFIED', reason: 'EXECUTION_EVIDENCE_UNVERIFIED' };
  const age =
    input.lastValidTrade === null
      ? Infinity
      : Date.parse(input.at) - Date.parse(input.lastValidTrade);
  if (age < 0 || age > input.maxAgeSeconds * 1000)
    return { market: 'STALE', reason: 'MARKET_OBSERVATIONS_STALE' };
  if (!input.indicatorsReady || !input.executableQuote)
    return {
      market: 'WARMING_UP',
      reason: 'REQUIRES_COMPLETE_INDICATOR_WINDOW_AND_QUOTE',
    };
  return { market: 'HEALTHY', reason: 'HEALTH_CHECKS_PASSED' };
}
