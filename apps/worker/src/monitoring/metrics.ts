import { sql } from 'drizzle-orm';
import type { Database } from '@solemn/database';

/** Recorded activity only. Unknown provider/infrastructure costs remain unavailable. */
export async function operationalMetrics(
  db: Database,
  portfolioId: string,
  strategyRunId: string,
) {
  const result = await db.execute(sql`
    select
      (select greatest(count(*)-1, 0)::text from forward_runtime_events
        where portfolio_id=${portfolioId} and kind='SESSION_STARTED') as "restarts",
      (select count(*)::text from strategy_decisions
        where run_id=${strategyRunId} and outcome='BUY_CANDIDATE') as "buyCandidates",
      (select count(*)::text from forward_runtime_events
        where portfolio_id=${portfolioId} and kind='INTENT_SETTLED'
        and details->'intent'->>'kind'='ENTRY' and details->>'status' <> 'FILLED') as "unfilledEntryIntents",
      (select count(*)::text from orders where portfolio_id=${portfolioId}) as "orders",
      (select count(*)::text from trades where portfolio_id=${portfolioId}) as "fills",
      (select count(*)::text from orders where portfolio_id=${portfolioId} and status='FAILED') as "failedOrders",
      (select count(*)::text from orders where portfolio_id=${portfolioId} and status='FAILED' and side='SELL') as "failedExits",
      (select max((details->>'currentDrawdownPercent')::numeric)::text from forward_runtime_events
        where portfolio_id=${portfolioId} and kind='EQUITY') as "maximumObservedSnapshotDrawdownPercent"
  `);
  return {
    ...result.rows[0],
    providerRequestCostUsd: null,
    infrastructureCostUsd: null,
  };
}
