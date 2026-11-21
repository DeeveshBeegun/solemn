import { executionObservationSchema, stableId, toAtomic } from '@solemn/shared';
import type { ExecutionObservation, PaperPolicy } from '@solemn/shared';
import type { FreeMarketSnapshot } from '../market/freeGeckoClient.js';

/** A deliberately simple paper model, not a venue quote or a reserve simulation.
 * Configured adverse slippage, percentage fees and liquidity limits are applied by PaperExecutor. */
export function freeSpotObservation(
  input: FreeMarketSnapshot,
  side: 'BUY' | 'SELL',
  at: string,
  policy: PaperPolicy,
): ExecutionObservation | null {
  const now = Date.parse(at);
  if (
    Date.parse(input.receivedAt) > now ||
    now - Date.parse(input.receivedAt) > policy.maxPriceAgeSeconds * 1000 ||
    toAtomic(input.liquidityUsd) <= 0n
  )
    return null;
  const newest = input.trades.reduce(
    (last, trade) => Math.max(last, Date.parse(trade.timestamp)),
    -Infinity,
  );
  const latest = input.trades.filter((t) => Date.parse(t.timestamp) === newest);
  if (
    !latest.length ||
    newest > now ||
    now - newest > policy.maxPriceAgeSeconds * 1000 ||
    new Set(latest.map((t) => t.priceUsd)).size !== 1 ||
    latest.some(
      (t) =>
        t.mint !== input.mint ||
        t.poolAddress !== input.pool ||
        t.quoteMint !== input.quoteMint ||
        t.source !== 'GECKOTERMINAL_PUBLIC' ||
        t.usdSource !== 'GECKOTERMINAL_TRADE_USD' ||
        !t.usdReliable ||
        t.priceUsd === null ||
        t.rawPayload.isAnomalous !== false ||
        Date.parse(t.receivedAt) > now,
    )
  )
    return null;
  const trade = latest.sort((a, b) => a.id.localeCompare(b.id))[0]!;
  return executionObservationSchema.parse({
    id: stableId(['free-spot-observation-v1', trade.id, side]),
    mint: input.mint,
    poolAddress: input.pool,
    side,
    observedAt: trade.timestamp,
    receivedAt: input.receivedAt,
    priceUsd: trade.priceUsd,
    liquidityUsd: input.liquidityUsd,
    estimatedPriceImpactPercent: null,
    usdReliable: true,
    healthy: true,
    usdSource: 'GECKOTERMINAL_TRADE_USD',
    source: 'GECKOTERMINAL_PUBLIC',
    sourceTradeId: trade.id,
    dataMode: 'LIVE_PAPER',
    simulationOutcome: 'FULL_FILL',
  });
}

export function isLaterPaperObservation(
  observation: ExecutionObservation,
  triggerAt: string,
) {
  return (
    Date.parse(observation.observedAt) > Date.parse(triggerAt) &&
    Date.parse(observation.receivedAt) > Date.parse(triggerAt)
  );
}
