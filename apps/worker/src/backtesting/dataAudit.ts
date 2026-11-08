import { sql } from 'drizzle-orm';
import type { Database } from '@solemn/database';
export async function auditOperationalHistory(db: Database) {
  const rows = async (query: ReturnType<typeof sql>) =>
    (await db.execute(query)).rows;
  const tokenCounts = await rows(
    sql`SELECT source_platform, count(*)::int AS count FROM tokens GROUP BY source_platform ORDER BY source_platform`,
  );
  const eventCounts = await rows(
    sql`SELECT event_type, count(*)::int AS count, min(event_at) AS earliest_event, max(event_at) AS latest_event, min(ingested_at) AS earliest_available, max(ingested_at) AS latest_available, count(*) FILTER (WHERE event_at IS NULL)::int AS missing_event_timestamps, count(*) FILTER (WHERE slot IS NOT NULL)::int AS with_slots, count(*) FILTER (WHERE transaction_signature IS NOT NULL)::int AS with_signatures FROM market_events GROUP BY event_type ORDER BY event_type`,
  );
  const riskCounts = await rows(
    sql`SELECT status, count(*)::int AS count, min(assessed_at) AS earliest, max(assessed_at) AS latest, count(*) FILTER (WHERE checks->>'liquidityUsd' IS NULL)::int AS missing_liquidity FROM token_risk_assessments GROUP BY status ORDER BY status`,
  );
  const replayCounts = await rows(
    sql`SELECT r.mode, count(*)::int AS trades, min(t.timestamp) AS earliest, max(t.timestamp) AS latest FROM market_trade_observations t JOIN strategy_runs r ON r.id=t.run_id GROUP BY r.mode`,
  );
  const counts = (
    await rows(
      sql`SELECT (SELECT count(*)::int FROM market_snapshots) AS market_snapshots, (SELECT count(*)::int FROM scanner_gaps) AS scanner_gaps, (SELECT count(*)::int FROM tokens t WHERE t.source_platform != 'PAPER_FIXTURE' AND NOT EXISTS (SELECT 1 FROM token_risk_assessments r WHERE r.token_mint=t.mint_address)) AS tokens_without_risk_history, (SELECT count(*)::int FROM market_candles) AS replay_candles, (SELECT count(*)::int FROM market_events) AS events, (SELECT count(*)::int FROM tokens WHERE source_platform != 'PAPER_FIXTURE') AS operational_tokens, (SELECT count(*)::int FROM token_risk_assessments) AS historical_assessments, (SELECT count(*)::int FROM market_events WHERE event_at IS NULL) AS missing_event_timestamps, (SELECT count(*)::int FROM (SELECT source, source_event_id FROM market_events GROUP BY source,source_event_id HAVING count(*)>1) duplicates) AS duplicate_events`,
    )
  )[0]!;
  return {
    generatedAt: new Date().toISOString(),
    source: 'OPERATIONAL_POSTGRESQL_READ_ONLY',
    readiness: 'INSUFFICIENT' as const,
    summary: {
      totalTokens: counts.operational_tokens,
      totalEvents: counts.events,
      totalRealIndividualTrades: 0,
      missingTimestamps: counts.missing_event_timestamps,
      duplicateEvents: counts.duplicate_events,
      marketDataGaps: counts.scanner_gaps,
      missingHistoricalSecurityAssessments: counts.tokens_without_risk_history,
      tokensWithInsufficientStrategyHistory: counts.operational_tokens,
      missingPriceObservations:
        'No complete real individual-trade price history is collected',
      missingLiquidityInformation:
        'Only timestamped risk-enrichment liquidity exists; no continuous execution-liquidity history',
      ...counts,
    },
    tokenCounts,
    eventCounts,
    riskCounts,
    replayCounts,
    limitations: [
      'Operational discovery events are not individual market trades.',
      'Existing normalized trades and candles are fixture/replay data and cannot establish real historical profitability.',
      'No complete real trade/coverage/execution-observation collection adapter exists; import a validated historical dataset before evaluating real history.',
      'Current token metadata or liquidity must not be backfilled into historical decisions.',
      'The operational audit reports ingestion and risk-assessment times separately; absent blockchain event times and slots remain unknown.',
    ],
  };
}
export type OperationalHistoryAudit = Awaited<
  ReturnType<typeof auditOperationalHistory>
>;
