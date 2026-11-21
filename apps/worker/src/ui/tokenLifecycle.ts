import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import { tokens } from '@solemn/database';
import type { Database } from '@solemn/database';
import { mintAddressSchema } from '@solemn/shared';
import { DataQueryError, readDatabase } from './dataExplorer.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const lifecycleStages = [
  'discovery',
  'risk',
  'strategy',
  'execution',
  'position',
] as const;
type Stage = (typeof lifecycleStages)[number];
type Context = {
  key: string;
  name: string;
  dataMode: string;
  status: string;
  portfolioId: string | null;
  runId: string | null;
  datasetId: string | null;
  sourceKind: string | null;
};
type Event = {
  id: string;
  at: string;
  stage: Stage;
  title: string;
  details: Record<string, unknown>;
  eventOrder: number;
};
type StageSummary = {
  stage: Stage;
  count: string;
  title: string;
  details: Record<string, unknown>;
};
export class TokenNotFound extends DataQueryError {}

function decodeCursor(raw: string | null) {
  if (!raw) return null;
  try {
    if (!/^[a-zA-Z0-9_-]{1,512}$/.test(raw)) throw new Error();
    const value: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === 'string' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(
        value[0],
      ) &&
      Number.isFinite(Date.parse(value[0])) &&
      typeof value[1] === 'number' &&
      Number.isInteger(value[1]) &&
      value[1] >= 0 &&
      value[1] <= 8 &&
      typeof value[2] === 'string' &&
      /^[a-zA-Z0-9:_-]{1,160}$/.test(value[2])
    )
      return { at: value[0], eventOrder: value[1], id: value[2] };
  } catch {
    // Invalid cursors are reported without reflecting input.
  }
  throw new DataQueryError('The history cursor is invalid. Refresh the token.');
}

export async function findLifecycleTokens(params: URLSearchParams) {
  const search = (params.get('search') ?? '').trim();
  const after = params.get('after');
  const traded = params.get('traded') ?? 'false';
  if (
    !['true', 'false'].includes(traded) ||
    search.length > 100 ||
    search.includes('\0') ||
    (after && !mintAddressSchema.safeParse(after).success)
  )
    throw new DataQueryError(
      'Enter a token name, symbol, or valid mint address.',
    );
  const match = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
  const paperActivity = sql<boolean>`exists(SELECT 1 FROM orders o WHERE o.token_mint=${tokens.mintAddress})
    OR exists(SELECT 1 FROM positions p WHERE p.token_mint=${tokens.mintAddress})`;
  return readDatabase(async (db) => {
    const rows = await db
      .select({
        mint: tokens.mintAddress,
        name: tokens.name,
        symbol: tokens.symbol,
        source: tokens.sourcePlatform,
        risk: tokens.riskStatus,
        hasPaperActivity: paperActivity,
      })
      .from(tokens)
      .where(
        and(
          search
            ? or(
                ilike(tokens.name, match),
                ilike(tokens.symbol, match),
                ilike(tokens.mintAddress, match),
              )
            : undefined,
          after ? lt(tokens.mintAddress, after) : undefined,
          traded === 'true' ? sql`(${paperActivity})` : undefined,
        ),
      )
      .orderBy(desc(tokens.mintAddress))
      .limit(26);
    return {
      tokens: rows.slice(0, 25),
      next: rows.length > 25 ? rows[24]!.mint : null,
    };
  });
}

export async function withTokenContext<T>(
  params: URLSearchParams,
  read: (
    db: Database,
    selection: {
      token: {
        mint: string;
        name: string | null;
        symbol: string | null;
        discoveredAt: string;
        createdAt: string | null;
        source: string;
        risk: string;
        migrationStatus: string;
        migratedAt: string | null;
      };
      context: Context;
      contexts: Context[];
      contextsTruncated: boolean;
    },
  ) => Promise<T>,
) {
  const mint = params.get('mint') ?? '';
  const requested = params.get('context') ?? '';
  if (!mintAddressSchema.safeParse(mint).success)
    throw new DataQueryError('Enter a valid Solana token mint.');
  if (
    requested &&
    !['discovery', 'legacy'].includes(requested) &&
    !/^(portfolio|strategy):/.test(requested)
  )
    throw new DataQueryError('Select a saved lifecycle context.');
  if (
    requested.includes(':') &&
    !uuid.test(requested.slice(requested.indexOf(':') + 1))
  )
    throw new DataQueryError('Select a valid account or strategy run.');
  return readDatabase(async (db) => {
    const metadata = (
      await db
        .select({
          mint: tokens.mintAddress,
          name: tokens.name,
          symbol: tokens.symbol,
          discoveredAt: tokens.discoveredAt,
          createdAt: tokens.createdAt,
          source: tokens.sourcePlatform,
          risk: tokens.riskStatus,
          migrationStatus: tokens.migrationStatus,
          migratedAt: tokens.migratedAt,
        })
        .from(tokens)
        .where(eq(tokens.mintAddress, mint))
        .limit(1)
    )[0];
    if (!metadata)
      throw new TokenNotFound(
        'This token has no saved metadata. Search another token.',
      );
    const contexts = await db.execute<Context>(sql`
      SELECT * FROM (
        SELECT 'portfolio:'||p.id::text AS key, p.name, p.data_mode AS "dataMode",
          coalesce(f.status,b.status,p.status) AS status, p.id::text AS "portfolioId",
          p.strategy_run_id::text AS "runId", b.dataset_id::text AS "datasetId",
          CASE WHEN p.definition->'freeExecution'->>'model'='FREE_PUBLIC_SPOT_V1' THEN 'LIVE_PAPER_SPOT' WHEN r.mode::text='LIVE_PAPER' THEN 'LIVE_PAPER' ELSE b.plan->>'sourceKind' END AS "sourceKind",
          greatest(r.created_at,coalesce(b.created_at,r.created_at),coalesce(f.started_at,r.created_at)) AS updated
        FROM paper_portfolios p
        JOIN strategy_runs r ON r.id=p.strategy_run_id
        LEFT JOIN backtest_runs b ON b.portfolio_id=p.id
        LEFT JOIN forward_accounts f ON f.portfolio_id=p.id
        WHERE EXISTS(SELECT 1 FROM strategy_decisions d WHERE d.run_id=p.strategy_run_id AND d.token_mint=${mint})
           OR EXISTS(SELECT 1 FROM orders o WHERE o.portfolio_id=p.id AND o.token_mint=${mint})
           OR EXISTS(SELECT 1 FROM positions x WHERE x.portfolio_id=p.id AND x.token_mint=${mint})
           OR EXISTS(SELECT 1 FROM market_trade_observations x WHERE x.run_id=p.strategy_run_id AND x.token_mint=${mint})
           OR EXISTS(SELECT 1 FROM market_candles x WHERE x.run_id=p.strategy_run_id AND x.token_mint=${mint})
           OR EXISTS(SELECT 1 FROM forward_runtime_events e WHERE e.portfolio_id=p.id AND e.details->>'mint'=${mint})
        UNION ALL
        SELECT 'strategy:'||r.id::text, r.strategy_id, r.mode::text, 'STRATEGY_RUN',
          null::text, r.id::text, null::text, null::text, r.created_at
        FROM strategy_runs r
        WHERE NOT EXISTS(SELECT 1 FROM paper_portfolios p WHERE p.strategy_run_id=r.id)
          AND (EXISTS(SELECT 1 FROM strategy_decisions d WHERE d.run_id=r.id AND d.token_mint=${mint})
            OR EXISTS(SELECT 1 FROM market_trade_observations o WHERE o.run_id=r.id AND o.token_mint=${mint})
            OR EXISTS(SELECT 1 FROM market_candles c WHERE c.run_id=r.id AND c.token_mint=${mint}))
      ) contexts
      ORDER BY (key=${requested} OR coalesce("runId"=${requested.startsWith('strategy:') ? requested.slice(9) : ''},false)) DESC,
        updated DESC, key LIMIT 201
    `);
    const available: Context[] = contexts.rows
      .slice(0, 200)
      .map(
        ({
          key,
          name,
          dataMode,
          status,
          portfolioId,
          runId,
          datasetId,
          sourceKind,
        }) => ({
          key,
          name,
          dataMode,
          status,
          portfolioId,
          runId,
          datasetId,
          sourceKind,
        }),
      );
    const legacy = await db.execute<{ present: boolean }>(sql`
      SELECT EXISTS(SELECT 1 FROM orders WHERE token_mint=${mint} AND portfolio_id IS NULL)
        OR EXISTS(SELECT 1 FROM positions WHERE token_mint=${mint} AND portfolio_id IS NULL)
        OR EXISTS(SELECT 1 FROM trading_signals WHERE token_mint=${mint}) AS present
    `);
    if (legacy.rows[0]?.present)
      available.push({
        key: 'legacy',
        name: 'Legacy paper records',
        dataMode: 'PAPER',
        status: 'SAVED',
        portfolioId: null,
        runId: null,
        datasetId: null,
        sourceKind: null,
      });
    available.push({
      key: 'discovery',
      name: 'Discovery and risk history',
      dataMode: metadata.source,
      status: 'SAVED',
      portfolioId: null,
      runId: null,
      datasetId: null,
      sourceKind: null,
    });
    const context = requested
      ? (available.find((item) => item.key === requested) ??
        (requested.startsWith('strategy:')
          ? available.find((item) => item.runId === requested.slice(9))
          : undefined))
      : available[0];
    if (!context)
      throw new DataQueryError(
        'That account has no saved lifecycle for this token.',
      );
    return read(db, {
      token: metadata,
      context,
      contexts: available,
      contextsTruncated: contexts.rows.length > 200,
    });
  });
}

export async function readTokenLifecycle(params: URLSearchParams) {
  const stage = params.get('stage') ?? '';
  if (stage && !lifecycleStages.includes(stage as Stage))
    throw new DataQueryError('Select a supported lifecycle stage.');
  const cursor = decodeCursor(params.get('cursor'));
  return withTokenContext(params, async (db, selection) => {
    const { token: metadata, context, contexts: available } = selection;
    const mint = metadata.mint;
    const { portfolioId, runId, datasetId } = context;
    const discovery = context.key === 'discovery';
    const trading = portfolioId !== null || context.key === 'legacy';

    // Project only recorded lifecycle evidence. Raw provider payloads and connection
    // details stay outside this read model. All run-specific sources share one scope.
    const events = sql`
      SELECT 'metadata:'||t.mint_address AS id, t.discovered_at AS at, 'discovery' AS stage,
        'Token discovered' AS title,
        jsonb_build_object('source',t.source_platform,'mint',t.mint_address) AS details
      FROM tokens t WHERE t.mint_address=${mint} AND ${discovery}
      UNION ALL
      SELECT 'market:'||e.id::text, coalesce(e.event_at,e.ingested_at), 'discovery', e.event_type,
        jsonb_build_object('source',e.source,'observedAt',e.ingested_at,'signature',e.transaction_signature)
      FROM market_events e WHERE e.token_mint=${mint} AND ${discovery}
      UNION ALL
      SELECT 'migration:'||t.mint_address, coalesce(t.migration_observed_at,t.migrated_at), 'discovery', 'Migration metadata recorded',
        jsonb_build_object('status',t.migration_status,'migratedAt',t.migrated_at,'venue',t.migration_venue)
      FROM tokens t WHERE t.mint_address=${mint} AND ${discovery}
        AND coalesce(t.migration_observed_at,t.migrated_at) IS NOT NULL
      UNION ALL
      SELECT 'risk:'||r.id::text, r.assessed_at, 'risk', 'Risk assessment',
        jsonb_build_object('status',r.status,'reasons',r.reasons,'validUntil',r.valid_until,'policyVersion',r.policy_version)
      FROM token_risk_assessments r WHERE r.token_mint=${mint} AND ${discovery}
      UNION ALL
      SELECT 'history:'||h.id::text, h.available_at,
        CASE WHEN h.kind='RISK' THEN 'risk' ELSE 'discovery' END,
        CASE WHEN h.kind='RISK' THEN 'Risk observation available' ELSE 'Dataset discovery' END,
        jsonb_build_object('source',h.payload->>'source','status',h.payload->'data'->>'currentStatus',
          'reasons',h.payload->'data'->'assessment'->'reasons','eventAt',h.event_at)
      FROM backtest_dataset_events h WHERE h.dataset_id=${datasetId}::uuid
        AND h.mint=${mint} AND h.kind IN ('DISCOVERY','RISK')
      UNION ALL
      SELECT 'observations:'||${runId}::text, min(o.timestamp), 'discovery', 'Market observations saved',
        jsonb_build_object('observations',count(*),'lastObservationAt',max(o.timestamp))
      FROM market_trade_observations o WHERE o.run_id=${runId}::uuid AND o.token_mint=${mint}
      HAVING count(*)>0
      UNION ALL
      SELECT 'candles:'||${runId}::text, min(c.end_time), 'strategy', 'Completed candles saved',
        jsonb_build_object('candles',count(*),'lastCandleAt',max(c.end_time))
      FROM market_candles c WHERE c.run_id=${runId}::uuid AND c.token_mint=${mint}
      HAVING count(*)>0
      UNION ALL
      SELECT 'context-risk:'||d.id::text, d.timestamp, 'risk', 'Risk context used by strategy',
        jsonb_build_object('status',d.payload->'risk'->>'currentStatus',
          'reasons',d.payload->'risk'->'assessment'->'reasons',
          'assessedAt',d.payload->'risk'->'assessment'->>'assessedAt',
          'availableAt',d.payload->'risk'->>'availableAt') AS details
      FROM strategy_decisions d WHERE d.run_id=${runId}::uuid AND d.token_mint=${mint}
        AND d.payload->'risk'<>'null'::jsonb
      UNION ALL
      SELECT 'decision:'||d.id::text, d.timestamp, 'strategy', d.outcome::text,
        jsonb_build_object('reasons',d.payload->'reasons','explanation',d.payload->>'explanation',
          'transitions',d.payload->'transitions','features',d.payload->'features','signalId',d.signal_id)
      FROM strategy_decisions d WHERE d.run_id=${runId}::uuid AND d.token_mint=${mint}
      UNION ALL
      SELECT 'legacy-signal:'||s.id::text, s.timestamp, 'strategy', s.signal_type::text||' signal',
        jsonb_build_object('strategyId',s.strategy_id,'strategyVersion',s.strategy_version,
          'explanation',s.explanation,'snapshotId',s.snapshot_id)
      FROM trading_signals s WHERE s.token_mint=${mint} AND ${context.key === 'legacy'}
      UNION ALL
      SELECT 'legacy-risk:'||s.id::text, s.timestamp, 'risk', 'Signal risk evidence',
        jsonb_build_object('status',s.risk_assessment->>'status')
      FROM trading_signals s WHERE s.token_mint=${mint} AND ${context.key === 'legacy'}
        AND s.risk_assessment IS NOT NULL
      UNION ALL
      SELECT 'order:'||o.id::text, o.created_at, 'execution', o.side::text||' order · '||o.status::text,
        jsonb_build_object('orderId',o.id,'status',o.status,'quantity',o.requested_quantity,
          'reason',o.paper_details->>'reason','failureReason',o.paper_details->>'failureReason',
          'lifecycle',o.paper_details->'lifecycle','executedAt',o.executed_at)
      FROM orders o WHERE o.token_mint=${mint} AND ${trading}
        AND o.portfolio_id IS NOT DISTINCT FROM ${portfolioId}::uuid
      UNION ALL
      SELECT 'fill:'||t.id::text, t.timestamp, 'execution', t.side::text||' paper fill',
        jsonb_build_object('orderId',t.order_id,'positionId',t.position_id,
          'quantity',t.executed_quantity,'priceUsd',t.execution_price_usd,'feesUsd',t.fees_usd,'notionalUsd',t.notional_usd)
      FROM trades t WHERE t.token_mint=${mint} AND ${trading}
        AND t.portfolio_id IS NOT DISTINCT FROM ${portfolioId}::uuid
      UNION ALL
      SELECT 'opened:'||p.id::text, p.opened_at, 'position', 'Paper position opened',
        jsonb_build_object('positionId',p.id,'entryPriceUsd',p.average_entry_price_usd)
      FROM positions p WHERE p.token_mint=${mint} AND ${trading}
        AND p.portfolio_id IS NOT DISTINCT FROM ${portfolioId}::uuid
      UNION ALL
      SELECT 'closed:'||p.id::text, p.closed_at, 'position', 'Paper position closed',
        jsonb_build_object('positionId',p.id,'realizedPnlUsd',p.realized_pnl_usd)
      FROM positions p WHERE p.token_mint=${mint} AND p.closed_at IS NOT NULL AND ${trading}
        AND p.portfolio_id IS NOT DISTINCT FROM ${portfolioId}::uuid
      UNION ALL
      SELECT 'ledger:'||e.id::text, e.timestamp, 'position', e.command->>'type',
        jsonb_build_object('positionId',e.command->>'positionId','reason',e.command->>'reason',
          'outcome',e.result->>'outcome','reasons',e.result->'reasons')
      FROM portfolio_balance_events e WHERE e.portfolio_id=${portfolioId}::uuid
        AND e.command->>'type' IN ('EXIT_UNAVAILABLE','SELL')
        AND e.command->>'positionId' IN (SELECT p.id::text FROM positions p WHERE p.token_mint=${mint} AND p.portfolio_id=${portfolioId}::uuid)
      UNION ALL
      SELECT 'intent:'||i.id::text, i.due_at, 'execution', 'Backtest execution intent scheduled',
        jsonb_build_object('kind',i.payload->>'kind','currentStatus',i.status,
          'reason',i.payload->>'reason','reasons',i.payload->'reasons','attemptedAt',i.payload->>'attemptedAt')
      FROM backtest_execution_intents i WHERE i.run_id IN (SELECT id FROM backtest_runs WHERE portfolio_id=${portfolioId}::uuid)
        AND i.payload->>'mint'=${mint}
      UNION ALL
      SELECT 'runtime:'||e.id::text, e.at,
        CASE WHEN e.kind='FIXTURE_DISCOVERY' THEN 'discovery' WHEN e.kind='CRITICAL_RISK' THEN 'risk' ELSE 'execution' END,
        e.kind,
        jsonb_build_object('status',coalesce(e.details->>'status',e.details->'risk'->>'currentStatus'),
          'reason',e.details->>'reason','reasons',e.details->'reasons',
          'orderId',e.details->>'orderId','intentKind',e.details->'intent'->>'kind')
      FROM forward_runtime_events e WHERE e.portfolio_id=${portfolioId}::uuid
        AND e.kind<>'SIGNAL'
        AND (e.details->>'mint'=${mint} OR e.details->'intent'->'candidate'->>'mint'=${mint}
          OR e.details->'intent'->>'positionId' IN (SELECT p.id::text FROM positions p WHERE p.token_mint=${mint} AND p.portfolio_id=${portfolioId}::uuid))
    `;

    const rankedEvents = sql`
      SELECT evidence.*, CASE
        WHEN stage='discovery' THEN 0 WHEN stage='risk' THEN 1 WHEN stage='strategy' THEN 2
        WHEN id LIKE 'intent:%' OR title='INTENT_OPENED' THEN 3
        WHEN id LIKE 'order:%' THEN 4 WHEN id LIKE 'fill:%' THEN 5
        WHEN id LIKE 'opened:%' THEN 6 WHEN id LIKE 'closed:%' THEN 8
        ELSE 7 END AS event_order
      FROM (${events}) evidence
    `;
    const summary = await db.execute<StageSummary>(sql`
      WITH events AS (${rankedEvents}), counts AS (
        SELECT stage,count(*)::text AS count FROM events WHERE at IS NOT NULL GROUP BY stage
      ), latest AS (
        SELECT DISTINCT ON(stage) stage,title,details FROM events
        WHERE at IS NOT NULL ORDER BY stage,at DESC,event_order DESC,id DESC
      ) SELECT counts.*,latest.title,latest.details FROM counts JOIN latest USING(stage)
    `);
    const page = await db.execute<Event>(sql`
      WITH events AS (${rankedEvents})
      SELECT id,at::text,stage,title,details,event_order AS "eventOrder" FROM events
      WHERE at IS NOT NULL AND (${stage}='' OR stage=${stage})
        AND (${cursor === null} OR (at,event_order,id)>(${cursor?.at ?? null}::timestamptz,${cursor?.eventOrder ?? null}::int,${cursor?.id ?? null}::text))
      ORDER BY at,event_order,id LIMIT 101
    `);
    const positionState = await db.execute<{
      total: string;
      open: string;
      blocked: string;
      realizedPnlUsd: string | null;
    }>(sql`
      SELECT count(*)::text AS total, count(*) FILTER(WHERE p.status<>'CLOSED')::text AS open,
        count(*) FILTER(WHERE p.paper_state='EXIT_BLOCKED')::text AS blocked,
        CASE WHEN coalesce(bool_or(coalesce((a.state->>'executionUncertain')::boolean,false)),false)
          THEN null ELSE sum(p.realized_pnl_usd)::text END AS "realizedPnlUsd"
      FROM positions p LEFT JOIN paper_portfolios a ON a.id=p.portfolio_id
      WHERE p.token_mint=${mint} AND ${trading}
        AND p.portfolio_id IS NOT DISTINCT FROM ${portfolioId}::uuid
    `);
    const positionRows = await db.execute(sql`
      SELECT p.id,p.paper_state AS "paperState",p.status,p.quantity,
        p.opened_at AS "openedAt",p.closed_at AS "closedAt",
        p.paper_details->>'blockedReason' AS "blockedReason",
        p.paper_details->>'pendingExitReason' AS "pendingExitReason",
        CASE WHEN coalesce((a.state->>'executionUncertain')::boolean,false) THEN null
          ELSE p.realized_pnl_usd::text END AS "realizedPnlUsd"
      FROM positions p LEFT JOIN paper_portfolios a ON a.id=p.portfolio_id
      WHERE p.token_mint=${mint} AND ${trading}
        AND p.portfolio_id IS NOT DISTINCT FROM ${portfolioId}::uuid
      ORDER BY p.opened_at DESC,p.id LIMIT 50
    `);
    const last = page.rows[99];
    return {
      token: metadata,
      context,
      contexts: available,
      contextsTruncated: selection.contextsTruncated,
      stages: summary.rows,
      positions: positionState.rows[0]!,
      positionRows: positionRows.rows,
      events: page.rows
        .slice(0, 100)
        .map((event) => ({ ...event, at: new Date(event.at).toISOString() })),
      next:
        page.rows.length > 100 && last
          ? Buffer.from(
              JSON.stringify([last.at, last.eventOrder, last.id]),
            ).toString('base64url')
          : null,
    };
  });
}
