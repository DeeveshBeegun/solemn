import { sql } from 'drizzle-orm';
import { mintAddressSchema } from '@solemn/shared';
import { DataQueryError } from './dataExplorer.js';
import { withTokenContext } from './tokenLifecycle.js';

type Candle = {
  at: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volumeUsd: string | null;
  samples: string;
};
type Fill = {
  id: string;
  at: string;
  side: string;
  quantity: string;
  priceUsd: string;
  notionalUsd: string;
  feesUsd: string;
  orderId: string;
  positionId: string | null;
};
const windows = { all: null, '1h': 3600, '24h': 86400, '7d': 604800 };

function cursor(raw: string | null) {
  if (!raw) return null;
  try {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(raw)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(
        value[0],
      ) &&
      Number.isFinite(Date.parse(value[0])) &&
      typeof value[1] === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value[1])
    )
      return { at: value[0], id: value[1] };
  } catch {
    /* Report invalid cursors without reflecting input. */
  }
  throw new DataQueryError('The trade cursor is invalid. Refresh the token.');
}

export async function readTokenTrading(params: URLSearchParams) {
  const range = params.get('range') ?? 'all';
  const side = params.get('side') ?? '';
  const requestedPool = params.get('pool') ?? '';
  if (!Object.hasOwn(windows, range) || !['', 'BUY', 'SELL'].includes(side))
    throw new DataQueryError('Select a supported time range and trade side.');
  if (
    requestedPool &&
    requestedPool !== 'unknown' &&
    !mintAddressSchema.safeParse(requestedPool).success
  )
    throw new DataQueryError('Select a saved market pool.');
  const after = cursor(params.get('cursor'));
  return withTokenContext(params, async (db, selection) => {
    const { token, context } = selection;
    const mint = token.mint;
    const trading = context.portfolioId !== null || context.key === 'legacy';
    const fillScope = sql`t.token_mint=${mint} AND ${trading}
      AND t.portfolio_id IS NOT DISTINCT FROM ${context.portfolioId}::uuid`;
    const pools = await db.execute<{
      pool: string;
      candles: string;
      observations: string;
    }>(sql`
      SELECT pool, sum(candles)::text AS candles,sum(observations)::text AS observations FROM (
        SELECT pool_address AS pool,count(*) AS candles,0 AS observations FROM market_candles
          WHERE run_id=${context.runId}::uuid AND token_mint=${mint} GROUP BY pool_address
        UNION ALL
        SELECT coalesce(pool_address,'unknown'),0,count(*) FROM market_trade_observations
          WHERE run_id=${context.runId}::uuid AND token_mint=${mint} GROUP BY pool_address
      ) x GROUP BY pool ORDER BY sum(candles) DESC,sum(observations) DESC,pool
    `);
    const pool = requestedPool || pools.rows[0]?.pool || '';
    const market = pools.rows.find((p) => p.pool === pool);
    if (requestedPool && !market)
      throw new DataQueryError(
        'That pool has no saved market history for this context.',
      );
    const source = market
      ? Number(market.candles)
        ? 'candles'
        : 'observations'
      : 'none';
    // No global snapshot fallback: a fixture, live account and another replay can
    // share the same mint. Only this strategy run and selected pool supply prices.
    const sourceRows =
      source === 'candles'
        ? sql`
      SELECT c.id,c.end_time AS at,c.start_time AS start,
        CASE WHEN (c.payload->>'complete')::boolean THEN c.payload->>'open' END AS open,
        CASE WHEN (c.payload->>'complete')::boolean THEN c.payload->>'high' END AS high,
        CASE WHEN (c.payload->>'complete')::boolean THEN c.payload->>'low' END AS low,
        CASE WHEN (c.payload->>'complete')::boolean THEN c.payload->>'close' END AS close,
        CASE WHEN (c.payload->>'complete')::boolean THEN c.payload->>'volumeUsd' END AS volume,
        (c.payload->>'tradeCount')::bigint AS samples
      FROM market_candles c WHERE c.run_id=${context.runId}::uuid AND c.token_mint=${mint} AND c.pool_address=${pool}
    `
        : sql`
      SELECT o.id,o.timestamp AS at,o.timestamp AS start,
        CASE WHEN (o.payload->>'usdReliable')::boolean THEN o.payload->>'priceUsd' END AS open,
        CASE WHEN (o.payload->>'usdReliable')::boolean THEN o.payload->>'priceUsd' END AS high,
        CASE WHEN (o.payload->>'usdReliable')::boolean THEN o.payload->>'priceUsd' END AS low,
        CASE WHEN (o.payload->>'usdReliable')::boolean THEN o.payload->>'priceUsd' END AS close,
        CASE WHEN (o.payload->>'usdReliable')::boolean THEN o.payload->>'volumeUsd' END AS volume,
        1::bigint AS samples
      FROM market_trade_observations o WHERE o.run_id=${context.runId}::uuid AND o.token_mint=${mint}
        AND coalesce(o.pool_address,'unknown')=${pool}
    `;
    const bounds = (
      await db.execute<{ first: string | null; last: string | null }>(sql`
      SELECT min(at)::text AS first,max(at)::text AS last FROM (
        SELECT at FROM (${sourceRows}) market
        UNION ALL SELECT t.timestamp FROM trades t WHERE ${fillScope}
      ) x
    `)
    ).rows[0]!;
    const seconds = windows[range as keyof typeof windows];
    const end = bounds.last;
    const start =
      end && seconds !== null
        ? new Date(Date.parse(end) - seconds * 1000).toISOString()
        : bounds.first;
    const bucketSeconds = Math.max(
      60,
      Math.ceil(
        (end && start ? (Date.parse(end) - Date.parse(start)) / 1000 : 0) /
          (480 * 60),
      ) * 60,
    );
    const inWindow = sql`t.timestamp>=${start}::timestamptz AND t.timestamp<=${end}::timestamptz`;
    const series = await db.execute<Candle>(sql`
      WITH source AS (${sourceRows}), bucketed AS (
        SELECT *,to_timestamp(floor(extract(epoch FROM at)/${bucketSeconds})*${bucketSeconds}) AS bucket
        FROM source WHERE at>=${start}::timestamptz AND at<=${end}::timestamptz
      ), grouped AS (
        SELECT bucket,min(start) AS start,max(at) AS at,
          (array_agg(open ORDER BY at,id))[1] AS open,
          max(high::numeric)::text AS high,min(low::numeric)::text AS low,
          (array_agg(close ORDER BY at DESC,id DESC))[1] AS close,
          CASE WHEN count(volume)=count(*) THEN sum(volume::numeric)::text END AS volume,
          bool_or(open IS NULL OR close IS NULL) AS missing, sum(samples)::text AS samples
        FROM bucketed GROUP BY bucket
      ) SELECT g.at::text,
        CASE WHEN NOT g.missing AND NOT gap.present THEN g.open END AS open,
        CASE WHEN NOT g.missing AND NOT gap.present THEN g.high END AS high,
        CASE WHEN NOT g.missing AND NOT gap.present THEN g.low END AS low,
        CASE WHEN NOT g.missing AND NOT gap.present THEN g.close END AS close,
        CASE WHEN NOT gap.present THEN g.volume END AS "volumeUsd",g.samples
      FROM grouped g CROSS JOIN LATERAL (
        SELECT exists(SELECT 1 FROM market_coverage_observations c WHERE c.run_id=${context.runId}::uuid
          AND c.token_mint=${mint} AND c.pool_address=${pool} AND c.kind='GAP'
          AND c.start<=g.at AND c.end>g.start) AS present
      ) gap ORDER BY g.bucket
    `);
    const totals = (
      await db.execute<{
        fills: string;
        buys: string;
        sells: string;
        buyNotionalUsd: string;
        sellNotionalUsd: string;
        feesUsd: string;
      }>(sql`
      SELECT count(*)::text AS fills,count(*) FILTER(WHERE t.side='BUY')::text AS buys,
        count(*) FILTER(WHERE t.side='SELL')::text AS sells,
        coalesce(sum(coalesce(t.notional_usd,t.executed_quantity*t.execution_price_usd)) FILTER(WHERE t.side='BUY'),0)::text AS "buyNotionalUsd",
        coalesce(sum(coalesce(t.notional_usd,t.executed_quantity*t.execution_price_usd)) FILTER(WHERE t.side='SELL'),0)::text AS "sellNotionalUsd",
        coalesce(sum(t.fees_usd),0)::text AS "feesUsd"
      FROM trades t WHERE ${fillScope} AND ${inWindow}
    `)
    ).rows[0]!;
    const projection = sql`t.id::text,t.timestamp::text AS at,t.side::text,t.executed_quantity::text AS quantity,
      t.execution_price_usd::text AS "priceUsd",coalesce(t.notional_usd,t.executed_quantity*t.execution_price_usd)::text AS "notionalUsd",
      t.fees_usd::text AS "feesUsd",t.order_id::text AS "orderId",t.position_id::text AS "positionId"`;
    const fills = await db.execute<Fill>(sql`
      SELECT ${projection} FROM trades t WHERE ${fillScope} AND ${inWindow}
        AND (${side}='' OR t.side::text=${side})
        AND (${after === null} OR (t.timestamp,t.id)<(${after?.at ?? null}::timestamptz,${after?.id ?? null}::uuid))
      ORDER BY t.timestamp DESC,t.id DESC LIMIT 51
    `);
    const markers = await db.execute<Fill & { pool: string | null }>(sql`
      SELECT ${projection},p.pool_address AS pool FROM trades t LEFT JOIN positions p ON p.id=t.position_id
      WHERE ${fillScope} AND ${inWindow} AND (p.pool_address=${pool} OR ${source === 'none'})
      ORDER BY t.timestamp DESC,t.id DESC LIMIT 501
    `);
    const position = (
      await db.execute<{
        total: string;
        open: string;
        blocked: string;
        realizedPnlUsd: string | null;
      }>(sql`
      SELECT count(*)::text AS total,count(*) FILTER(WHERE p.status='OPEN')::text AS open,
        count(*) FILTER(WHERE p.paper_state='EXIT_BLOCKED')::text AS blocked,
        CASE WHEN count(*)=0 OR coalesce(bool_or(coalesce((a.state->>'executionUncertain')::boolean,false)),false) THEN null
          ELSE coalesce(sum(p.realized_pnl_usd),0)::text END AS "realizedPnlUsd"
      FROM positions p LEFT JOIN paper_portfolios a ON a.id=p.portfolio_id WHERE p.token_mint=${mint}
        AND ${trading} AND p.portfolio_id IS NOT DISTINCT FROM ${context.portfolioId}::uuid
    `)
    ).rows[0]!;
    const last = fills.rows[49];
    return {
      ...selection,
      range,
      side,
      pool,
      pools: pools.rows,
      source,
      window: { from: start, through: end, bucketSeconds },
      candles: series.rows.map((row) => ({
        ...row,
        at: new Date(row.at).toISOString(),
      })),
      totals,
      positions: position,
      fills: fills.rows
        .slice(0, 50)
        .map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
      markers: markers.rows
        .slice(0, 500)
        .map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
      markersTruncated: markers.rows.length > 500,
      next:
        fills.rows.length > 50 && last
          ? Buffer.from(JSON.stringify([last.at, last.id])).toString(
              'base64url',
            )
          : null,
    };
  });
}
