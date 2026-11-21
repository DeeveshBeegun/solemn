import { sql } from 'drizzle-orm';
import type { Database } from '@solemn/database';
import { readDatabase } from './dataExplorer.js';

type EntryDecision = {
  id: string;
  decisionId: string;
  signalId: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  hasMetadata: boolean;
  portfolioId: string;
  accountName: string;
  dataMode: string;
  sourceKind: string | null;
  decidedAt: string;
  recordedAt: string;
  status: string;
  explanation: string;
  reasons: string[];
  referencePriceUsd: string | null;
  candleEnd: string | null;
  fillPriceUsd: string | null;
  quantity: string | null;
  feesUsd: string | null;
  total: string;
};

export async function queryPaperEntryAlerts(db: Database, now: string) {
  // Use database recording time to notice a new replay of old market timestamps.
  // Candidates without an owning paper account are strategy research, not entries.
  const result = await db.execute<EntryDecision>(sql`
    WITH recent AS (
      SELECT p.id::text||':'||d.signal_id::text AS id,d.id AS decision_id,d.signal_id,
        d.mode AS strategy_mode,d.token_mint,d.timestamp,d.created_at,d.payload,p.id AS portfolio_id,
        p.name AS account_name,p.data_mode,p.definition->'freeExecution'->>'model' AS execution_model,p.strategy_run_id,count(*) OVER()::text AS total
      FROM strategy_decisions d JOIN paper_portfolios p ON p.strategy_run_id=d.run_id
      WHERE p.mode='PAPER' AND d.outcome='BUY_CANDIDATE' AND d.signal_id IS NOT NULL
        AND d.payload->'candidate' IS NOT NULL AND d.payload->'candidate'<>'null'::jsonb
        AND d.created_at>=${now}::timestamptz-interval '24 hours' AND d.created_at<=${now}::timestamptz
      ORDER BY d.created_at DESC,d.id DESC,p.id LIMIT 101
    )
    SELECT d.id,d.decision_id::text AS "decisionId",d.signal_id::text AS "signalId",
      d.token_mint AS mint,t.name,t.symbol,(t.mint_address IS NOT NULL) AS "hasMetadata",
      d.portfolio_id::text AS "portfolioId",d.account_name AS "accountName",d.data_mode AS "dataMode",
      CASE WHEN d.execution_model='FREE_PUBLIC_SPOT_V1' THEN 'LIVE_PAPER_SPOT' WHEN d.strategy_mode::text='LIVE_PAPER' THEN 'LIVE_PAPER' ELSE b.plan->>'sourceKind' END AS "sourceKind",d.timestamp AS "decidedAt",d.created_at AS "recordedAt",
      CASE WHEN ledger.result->>'outcome'='ENTRY_FILLED' AND fill.id IS NOT NULL THEN 'FILLED'
        WHEN ledger.result->>'outcome'='ENTRY_FILLED' THEN 'EXECUTION_UNCERTAIN'
        WHEN ledger.result->>'outcome'='ENTRY_REJECTED' THEN 'REJECTED'
        WHEN (f.kind='INTENT_SETTLED' AND f.details->>'status'='FILLED') OR i.status='FILLED' THEN 'EXECUTION_UNCERTAIN'
        WHEN f.kind='INTENT_SETTLED' THEN coalesce(f.details->>'status','SETTLED')
        WHEN i.status IS NOT NULL AND i.status<>'PENDING' THEN i.status
        WHEN f.kind='INTENT_OPENED' OR i.status='PENDING' THEN 'QUEUED'
        WHEN d.execution_model='FREE_PUBLIC_SPOT_V1' THEN 'AWAITING_MARKET_DATA'
        ELSE 'CANDIDATE_ONLY' END AS status,
      coalesce(d.payload->>'explanation','BUY candidate recorded') AS explanation,
      coalesce(ledger.result->'reasons',f.details->'reasons',i.payload->'reasons',d.payload->'reasons','[]'::jsonb) AS reasons,
      d.payload->'candidate'->>'referencePriceUsd' AS "referencePriceUsd",d.payload->'candidate'->>'candleEnd' AS "candleEnd",
      fill.execution_price_usd::text AS "fillPriceUsd",fill.executed_quantity::text AS quantity,
      fill.fees_usd::text AS "feesUsd",d.total
    FROM recent d LEFT JOIN tokens t ON t.mint_address=d.token_mint
    LEFT JOIN backtest_runs b ON b.portfolio_id=d.portfolio_id
    LEFT JOIN LATERAL (
      SELECT e.result FROM portfolio_balance_events e WHERE e.portfolio_id=d.portfolio_id
        AND e.command->>'type'='ENTRY' AND e.command->'candidate'->>'id'=d.signal_id::text
      ORDER BY e.sequence DESC LIMIT 1
    ) ledger ON true
    LEFT JOIN LATERAL (
      SELECT tr.id,tr.execution_price_usd,tr.executed_quantity,tr.fees_usd FROM trades tr
      WHERE tr.portfolio_id=d.portfolio_id AND tr.token_mint=d.token_mint AND tr.side='BUY'
        AND tr.order_id::text=ledger.result->>'orderId' LIMIT 1
    ) fill ON true
    LEFT JOIN LATERAL (
      SELECT e.kind,e.details FROM forward_runtime_events e WHERE e.portfolio_id=d.portfolio_id
        AND e.kind IN ('INTENT_OPENED','INTENT_SETTLED') AND e.details->'intent'->>'kind'='ENTRY'
        AND e.details->'intent'->'candidate'->>'id'=d.signal_id::text
      ORDER BY e.recorded_at DESC,(e.kind='INTENT_SETTLED') DESC,e.id DESC LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT i.status,i.payload FROM backtest_execution_intents i WHERE i.run_id=b.id
        AND i.payload->>'kind'='ENTRY' AND i.payload->>'signalId'=d.signal_id::text
      ORDER BY i.due_at DESC,i.id DESC LIMIT 1
    ) i ON true
    ORDER BY d.created_at DESC,d.decision_id DESC,d.portfolio_id
  `);
  return {
    checkedAt: now,
    total: Number(result.rows[0]?.total ?? 0),
    truncated: result.rows.length > 100,
    entries: result.rows.slice(0, 100).map(({ total, ...entry }) => {
      void total;
      return {
        ...entry,
        decidedAt: new Date(entry.decidedAt).toISOString(),
        recordedAt: new Date(entry.recordedAt).toISOString(),
      };
    }),
  };
}
export function readPaperEntryAlerts() {
  return readDatabase((db) =>
    queryPaperEntryAlerts(db, new Date().toISOString()),
  );
}
