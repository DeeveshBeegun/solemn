import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createHistoryRepository,
  createBacktestRepository,
  createPaperRepository,
  createStrategyRepository,
  createRepository,
  migrateDatabase,
  tokens,
  marketSnapshots,
  tradingSignals,
} from '@solemn/database';
import { createBacktestFixture } from '../src/backtesting/replayFixture.js';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
} from '../src/backtesting/historicalDataProvider.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { backtestConfig } from './backtestFixtures.js';
import { createLogger } from '../src/services/logger.js';
import {
  readTokenLifecycle,
  findLifecycleTokens,
  TokenNotFound,
} from '../src/ui/tokenLifecycle.js';
import { queryPaperEntryAlerts } from '../src/ui/paperEntryAlerts.js';
import { readTokenTrading } from '../src/ui/tokenTrading.js';
import { DataQueryError } from '../src/ui/dataExplorer.js';
import { event, token, snapshot, signal } from '../../../tests/fixtures.js';

dotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const originalUrl = process.env.DATABASE_URL;
const testUrl = assertSafeTestDatabase(
  process.env.TEST_DATABASE_URL,
  originalUrl,
);
const control = createDatabase(testUrl, undefined, {
  storageMaintenance: false,
});
const scratch = 'solemn_lifecycle_' + randomUUID().replaceAll('-', '');
let created = false;
let database: ReturnType<typeof createDatabase>;
let closedMint: string;
let blockedMint: string;
let portfolioA: string;
let portfolioB: string;
let strategyA: string;
beforeAll(async () => {
  await control.pool.query('CREATE DATABASE "' + scratch + '"');
  created = true;
  const url = new URL(testUrl);
  url.pathname = '/' + scratch;
  process.env.DATABASE_URL = url.href;
  database = createDatabase(url.href, undefined, { storageMaintenance: false });
  await migrateDatabase(database.db);
  const file = createBacktestFixture(backtestConfig);
  const history = createHistoryRepository(database.db);
  const dataset = await history.register(
    file.manifest,
    historyEvents(file.events),
    100,
    100000,
  );
  for (let n = 0; n < 2; n++) {
    const plan = createBacktestPlan(
      { dataset: 'fixtures', runId: randomUUID() },
      dataset,
      backtestConfig,
    );
    await runBacktest(
      plan,
      new PostgresHistoricalDataProvider(dataset, history),
      backtestConfig,
      {
        paper: createPaperRepository(database.db),
        strategy: createStrategyRepository(database.db),
        backtests: createBacktestRepository(database.db),
      },
      createLogger('silent'),
    );
    if (n === 0) {
      portfolioA = plan.portfolioId;
      strategyA = plan.strategyRunId;
    } else portfolioB = plan.portfolioId;
  }
  await database.db.insert(tokens).values(token).onConflictDoNothing();
  const snapshotId = randomUUID();
  await database.db
    .insert(marketSnapshots)
    .values({ ...snapshot, id: snapshotId });
  await database.db.insert(tradingSignals).values({
    id: randomUUID(),
    tokenMint: token.mintAddress,
    signalType: signal.signalType,
    strategyId: signal.strategyId,
    strategyVersion: signal.strategyVersion,
    timestamp: signal.timestamp,
    explanation: signal.explanation,
    snapshotId,
    riskAssessment: signal.riskAssessment,
  });
  closedMint = (
    await database.pool.query(
      "SELECT token_mint FROM positions WHERE portfolio_id=$1 AND status='CLOSED' ORDER BY token_mint LIMIT 1",
      [portfolioA],
    )
  ).rows[0].token_mint;
  blockedMint = (
    await database.pool.query(
      "SELECT token_mint FROM positions WHERE portfolio_id=$1 AND paper_state='EXIT_BLOCKED' LIMIT 1",
      [portfolioA],
    )
  ).rows[0].token_mint;
  for (let i = 0; i < 110; i++) {
    const id = randomUUID();
    await createRepository(database.db).insertMarketEvent({
      ...event,
      id,
      tokenMint: closedMint,
      sourceEventId: id,
      eventAt: '2020-01-01T00:00:00.123456Z',
      ingestedAt: new Date().toISOString(),
    });
  }
}, 30000);
afterAll(async () => {
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  await database?.close();
  if (created)
    await control.pool.query('DROP DATABASE "' + scratch + '" WITH (FORCE)');
  await control.close();
});

it('shows discovery, risk, strategy, fills and closed-position evidence for the selected account only', async () => {
  const data = await readTokenLifecycle(
    new URLSearchParams({
      mint: closedMint,
      context: 'portfolio:' + portfolioA,
    }),
  );
  expect(data.context.portfolioId).toBe(portfolioA);
  expect(data.context.dataMode).toBe('FIXTURE');
  expect(data.context.sourceKind).toBe('SYNTHETIC');
  expect(data.contexts.some((item) => item.portfolioId === portfolioB)).toBe(
    true,
  );
  expect(data.stages.map((item) => item.stage).sort()).toEqual([
    'discovery',
    'execution',
    'position',
    'risk',
    'strategy',
  ]);
  expect(data.positions.open).toBe('0');
  expect(Number(data.positions.total)).toBeGreaterThan(0);
  expect(
    data.events.some((item) => item.title === 'Paper position closed'),
  ).toBe(true);
  const orderIds = (
    await database.pool.query(
      'SELECT id FROM orders WHERE portfolio_id=$1 AND token_mint=$2',
      [portfolioA, closedMint],
    )
  ).rows.map((row) => row.id);
  expect(
    data.events
      .filter((item) => item.details.orderId)
      .every((item) => orderIds.includes(item.details.orderId)),
  ).toBe(true);
  const discoveryIds = (
    await database.pool.query(
      'SELECT id FROM market_events WHERE token_mint=$1',
      [closedMint],
    )
  ).rows.map((row) => 'market:' + row.id);
  expect(data.events.some((item) => discoveryIds.includes(item.id))).toBe(
    false,
  );
});

it('reports a blocked exit as an unresolved open position', async () => {
  const data = await readTokenLifecycle(
    new URLSearchParams({
      mint: blockedMint,
      context: 'portfolio:' + portfolioA,
    }),
  );
  expect(Number(data.positions.open)).toBeGreaterThan(0);
  expect(Number(data.positions.blocked)).toBeGreaterThan(0);
  expect(
    data.positionRows.some((row) => row.paperState === 'EXIT_BLOCKED'),
  ).toBe(true);
  expect(
    data.events.some((item) => item.title === 'Paper position closed'),
  ).toBe(false);
});

it('paginates tied timestamps without losing or repeating discovery evidence', async () => {
  const query = { mint: closedMint, context: 'discovery' };
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const data = await readTokenLifecycle(
      new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) }),
    );
    expect(
      data.events.every(
        (item) => item.stage === 'discovery' || item.stage === 'risk',
      ),
    ).toBe(true);
    ids.push(...data.events.map((item) => item.id));
    cursor = data.next;
  } while (cursor);
  expect(ids.filter((id) => id.startsWith('market:'))).toHaveLength(110);
  expect(new Set(ids).size).toBe(ids.length);
});

it('filters stages, resolves strategy links to their account, and searches tokens with paper activity', async () => {
  const data = await readTokenLifecycle(
    new URLSearchParams({
      mint: closedMint,
      context: 'strategy:' + strategyA,
      stage: 'execution',
    }),
  );
  expect(data.context.portfolioId).toBe(portfolioA);
  expect(data.events.length).toBeGreaterThan(0);
  expect(data.events.every((item) => item.stage === 'execution')).toBe(true);
  for (const fill of data.events.filter((item) =>
    item.id.startsWith('fill:'),
  )) {
    const orderIndex = data.events.findIndex(
      (item) => item.id === 'order:' + fill.details.orderId,
    );
    expect(orderIndex).toBeGreaterThanOrEqual(0);
    expect(orderIndex).toBeLessThan(data.events.indexOf(fill));
  }
  const results = await findLifecycleTokens(
    new URLSearchParams({ search: closedMint, traded: 'true' }),
  );
  expect(results.tokens).toHaveLength(1);
  expect(results.tokens[0]?.hasPaperActivity).toBe(true);
});

it('rejects malformed queries and unknown tokens without changing stored data', async () => {
  await expect(
    readTokenLifecycle(new URLSearchParams({ mint: 'invalid' })),
  ).rejects.toBeInstanceOf(DataQueryError);
  await expect(
    readTokenLifecycle(
      new URLSearchParams({ mint: closedMint, context: 'portfolio:invalid' }),
    ),
  ).rejects.toBeInstanceOf(DataQueryError);
  await expect(
    readTokenLifecycle(
      new URLSearchParams({ mint: closedMint, stage: 'unknown' }),
    ),
  ).rejects.toBeInstanceOf(DataQueryError);
  await expect(
    readTokenLifecycle(
      new URLSearchParams({ mint: closedMint, cursor: 'bad' }),
    ),
  ).rejects.toBeInstanceOf(DataQueryError);
  await expect(
    readTokenLifecycle(
      new URLSearchParams({ mint: '11111111111111111111111111111111' }),
    ),
  ).rejects.toBeInstanceOf(TokenNotFound);
  expect(
    (await database.pool.query('SELECT count(*)::int AS n FROM backtest_runs'))
      .rows[0].n,
  ).toBe(2);
});

it('includes earlier standalone signal evidence in its legacy context', async () => {
  const data = await readTokenLifecycle(
    new URLSearchParams({ mint: token.mintAddress, context: 'legacy' }),
  );
  expect(data.context.key).toBe('legacy');
  expect(data.events.some((item) => item.title === 'HOLD signal')).toBe(true);
  expect(
    data.events.some((item) => item.title === 'Signal risk evidence'),
  ).toBe(true);
});

it('keeps later risk-status changes even when the underlying assessment is reused', async () => {
  const latest = (
    await database.pool.query(
      'SELECT id FROM strategy_decisions WHERE run_id=$1 AND token_mint=$2 ORDER BY timestamp DESC,id DESC LIMIT 1',
      [strategyA, closedMint],
    )
  ).rows[0];
  await database.pool.query(
    `UPDATE strategy_decisions SET payload=jsonb_set(payload,'{risk,currentStatus}','"UNKNOWN"'::jsonb) WHERE id=$1`,
    [latest.id],
  );
  const data = await readTokenLifecycle(
    new URLSearchParams({
      mint: closedMint,
      context: 'portfolio:' + portfolioA,
      stage: 'risk',
    }),
  );
  expect(
    data.events.find((item) => item.id === 'context-risk:' + latest.id)?.details
      .status,
  ).toBe('UNKNOWN');
});

it('charts the selected replay and reconciles full-window paper fills, fees and realized P&L', async () => {
  const data = await readTokenTrading(
    new URLSearchParams({
      mint: closedMint,
      context: 'portfolio:' + portfolioA,
    }),
  );
  expect(data.context.portfolioId).toBe(portfolioA);
  expect(data.source).toBe('candles');
  expect(data.candles.length).toBeGreaterThan(1);
  expect(data.candles.length).toBeLessThanOrEqual(481);
  const expected = (
    await database.pool.query(
      `SELECT count(*)::text AS n,sum(fees_usd)::text AS fees FROM trades WHERE portfolio_id=$1 AND token_mint=$2`,
      [portfolioA, closedMint],
    )
  ).rows[0];
  expect(data.totals.fills).toBe(expected.n);
  expect(Number(data.totals.feesUsd)).toBe(Number(expected.fees));
  const ids = (
    await database.pool.query(
      'SELECT id FROM trades WHERE portfolio_id=$1 AND token_mint=$2',
      [portfolioA, closedMint],
    )
  ).rows.map((r) => r.id);
  expect(data.fills.map((f) => f.id).sort()).toEqual(ids.sort());
  expect(data.markers.every((m) => ids.includes(m.id))).toBe(true);
  expect(data.candles.some((c) => c.close !== null)).toBe(true);
  const lifecycle = await readTokenLifecycle(
    new URLSearchParams({
      mint: closedMint,
      context: 'portfolio:' + portfolioA,
    }),
  );
  expect(data.positions.realizedPnlUsd).toBe(
    lifecycle.positions.realizedPnlUsd,
  );
});

it('uses the saved event clock for ranges and filters the fills table independently of totals', async () => {
  const data = await readTokenTrading(
    new URLSearchParams({
      mint: closedMint,
      context: 'portfolio:' + portfolioA,
      range: '1h',
      side: 'BUY',
    }),
  );
  expect(Date.parse(data.window.through!) - Date.parse(data.window.from!)).toBe(
    3600000,
  );
  expect(data.fills.length).toBeGreaterThan(0);
  expect(data.fills.every((f) => f.side === 'BUY')).toBe(true);
  expect(Number(data.totals.sells)).toBeGreaterThan(0);
  expect(
    data.candles.every(
      (p) =>
        Date.parse(p.at) >= Date.parse(data.window.from!) &&
        Date.parse(p.at) <= Date.parse(data.window.through!),
    ),
  ).toBe(true);
  const resolved = await readTokenTrading(
    new URLSearchParams({ mint: closedMint, context: 'strategy:' + strategyA }),
  );
  expect(resolved.context.portfolioId).toBe(portfolioA);
});

it('keeps discovery-only tokens honest and never borrows another run’s market prices', async () => {
  const data = await readTokenTrading(
    new URLSearchParams({ mint: closedMint, context: 'discovery' }),
  );
  expect(data.source).toBe('none');
  expect(data.candles).toEqual([]);
  expect(data.fills).toEqual([]);
  expect(data.totals.fills).toBe('0');
  expect(data.window.through).toBeNull();
  const legacy = await readTokenTrading(
    new URLSearchParams({ mint: token.mintAddress, context: 'legacy' }),
  );
  expect(legacy.candles).toEqual([]);
});

it('preserves gaps and unavailable USD values in chart intervals', async () => {
  const params = new URLSearchParams({
    mint: closedMint,
    context: 'portfolio:' + portfolioA,
  });
  const before = await readTokenTrading(params);
  const candle = (
    await database.pool.query(
      'SELECT id FROM market_candles WHERE run_id=$1 AND token_mint=$2 AND pool_address=$3 ORDER BY end_time,id LIMIT 1',
      [strategyA, closedMint, before.pool],
    )
  ).rows[0];
  await database.pool.query(
    `UPDATE market_candles SET payload=jsonb_set(payload,'{complete}','false'::jsonb) WHERE run_id=$1 AND id=$2`,
    [strategyA, candle.id],
  );
  const after = await readTokenTrading(params);
  expect(after.candles[0]?.close).toBeNull();
  expect(after.candles[0]?.volumeUsd).toBeNull();
  await database.pool.query(
    `UPDATE market_candles SET payload=jsonb_set(payload,'{complete}','true'::jsonb) WHERE run_id=$1 AND id=$2`,
    [strategyA, candle.id],
  );
});

it('keeps unresolved exits open and suppresses unreliable realized P&L', async () => {
  const params = new URLSearchParams({
    mint: blockedMint,
    context: 'portfolio:' + portfolioA,
  });
  const data = await readTokenTrading(params);
  expect(Number(data.positions.blocked)).toBeGreaterThan(0);
  expect(Number(data.positions.open)).toBeGreaterThan(0);
  const command = {
    type: 'HALT' as const,
    id: randomUUID(),
    at: new Date().toISOString(),
    reason: 'Execution uncertainty test',
  };
  await createPaperRepository(database.db).transact(
    portfolioA,
    command,
    (state) => ({
      state: {
        ...state,
        executionUncertain: true,
        status: 'HALTED',
        haltReason: command.reason,
        asOf: command.at,
      },
      postings: [],
      orders: [],
      result: {
        outcome: 'HALTED',
        reasons: [command.reason],
        orderId: null,
        positionId: null,
      },
    }),
  );
  const uncertain = await readTokenTrading(params);
  expect(uncertain.positions.realizedPnlUsd).toBeNull();
});

it('rejects invalid trading filters, cursors and unavailable pools', async () => {
  for (const extra of [
    { range: 'invalid' },
    { side: 'SHORT' },
    { pool: 'invalid' },
    { cursor: 'invalid' },
    { context: 'portfolio:invalid' },
    { pool: '11111111111111111111111111111111' },
  ]) {
    await expect(
      readTokenTrading(
        new URLSearchParams({
          mint: closedMint,
          context: 'portfolio:' + portfolioA,
          ...extra,
        }),
      ),
    ).rejects.toBeInstanceOf(DataQueryError);
  }
});

it('paginates same-timestamp legacy fills at full database precision without dropping rows', async () => {
  const ids: string[] = [];
  for (let n = 0; n < 61; n++) {
    const id = randomUUID(),
      order = randomUUID();
    ids.push(id);
    await database.pool.query(
      `INSERT INTO orders(id,token_mint,side,requested_quantity,status,created_at,submitted_at,executed_at,estimated_fees_usd,actual_fees_usd)
      VALUES($1,$2,'BUY',1,'FILLED','2020-01-01T00:00:00.123456Z','2020-01-01T00:00:00.123456Z','2020-01-01T00:00:00.123456Z',0,0)`,
      [order, token.mintAddress],
    );
    await database.pool.query(
      `INSERT INTO trades(id,order_id,token_mint,side,executed_quantity,execution_price_usd,fees_usd,timestamp)
      VALUES($1,$2,$3,'BUY',1,2,0,'2020-01-01T00:00:00.123456Z')`,
      [id, order, token.mintAddress],
    );
  }
  const params = { mint: token.mintAddress, context: 'legacy' };
  const first = await readTokenTrading(new URLSearchParams(params));
  expect(first.fills).toHaveLength(50);
  expect(first.next).not.toBeNull();
  expect(Number(first.totals.buyNotionalUsd)).toBe(122);
  const second = await readTokenTrading(
    new URLSearchParams({ ...params, cursor: first.next! }),
  );
  expect(second.fills).toHaveLength(11);
  expect(second.next).toBeNull();
  expect([...first.fills, ...second.fills].map((f) => f.id).sort()).toEqual(
    ids.sort(),
  );
  expect(first.markers).toHaveLength(61);
});

it('separates market pools and exposes only reliable, projected observation data', async () => {
  const run = randomUUID();
  await database.pool.query(
    `INSERT INTO strategy_runs(id,mode,strategy_id,strategy_version,config_hash,risk_policy_hash,config)
    SELECT $1,mode,strategy_id,strategy_version,config_hash,risk_policy_hash,config FROM strategy_runs WHERE id=$2`,
    [run, strategyA],
  );
  const otherPool = '11111111111111111111111111111111';
  const known = await readTokenTrading(
    new URLSearchParams({
      mint: closedMint,
      context: 'portfolio:' + portfolioA,
    }),
  );
  const trade = createBacktestFixture(backtestConfig).events.find(
    (event) => event.kind === 'TRADE',
  );
  if (!trade) throw new Error('Fixture needs a market trade');
  const payload = trade.data;
  for (const [n, pool, reliable] of [
    [0, known.pool, true],
    [1, otherPool, false],
  ] as const) {
    await database.pool.query(
      `INSERT INTO market_trade_observations(run_id,id,token_mint,pool_address,source,source_event_id,timestamp,received_at,payload)
      VALUES($1,$2,$3,$4,'TEST',$5,'2020-01-01','2020-01-01',$6)`,
      [
        run,
        randomUUID(),
        closedMint,
        pool,
        String(n),
        {
          ...payload,
          mint: closedMint,
          poolAddress: pool,
          usdReliable: reliable,
          rawPayload: { privateValue: 'DO_NOT_EXPOSE' },
        },
      ],
    );
  }
  const good = await readTokenTrading(
    new URLSearchParams({
      mint: closedMint,
      context: 'strategy:' + run,
      pool: known.pool,
    }),
  );
  expect(good.source).toBe('observations');
  expect(good.pools).toHaveLength(2);
  expect(good.candles).toHaveLength(1);
  expect(good.candles[0]?.close).toBe(payload.priceUsd);
  const unknown = await readTokenTrading(
    new URLSearchParams({
      mint: closedMint,
      context: 'strategy:' + run,
      pool: otherPool,
    }),
  );
  expect(unknown.candles[0]?.close).toBeNull();
  expect(unknown.candles[0]?.volumeUsd).toBeNull();
  expect(JSON.stringify(unknown)).not.toContain('DO_NOT_EXPOSE');
  expect(unknown.positions.realizedPnlUsd).toBeNull();
});

it('lists account-owned paper entry decisions with source clocks and confirmed fill outcomes', async () => {
  const data = await queryPaperEntryAlerts(
    database.db,
    new Date().toISOString(),
  );
  const expected = (
    await database.pool.query(
      `SELECT d.id FROM strategy_decisions d JOIN paper_portfolios p ON p.strategy_run_id=d.run_id WHERE d.outcome='BUY_CANDIDATE'`,
    )
  ).rows.map((row) => row.id);
  expect(data.entries.length).toBeGreaterThan(0);
  expect(data.entries.map((entry) => entry.decisionId).sort()).toEqual(
    expected.sort(),
  );
  expect(new Set(data.entries.map((entry) => entry.id)).size).toBe(
    data.entries.length,
  );
  expect(
    data.entries.every(
      (entry) =>
        entry.dataMode === 'FIXTURE' && entry.sourceKind === 'SYNTHETIC',
    ),
  ).toBe(true);
  expect(
    data.entries.every((entry) => entry.decidedAt.startsWith('2026-01-01')),
  ).toBe(true);
  expect(
    data.entries.every(
      (entry) => Date.parse(entry.recordedAt) > Date.parse(entry.decidedAt),
    ),
  ).toBe(true);
  const filled = data.entries.filter((entry) => entry.status === 'FILLED');
  expect(filled.length).toBeGreaterThan(0);
  expect(
    filled.every(
      (entry) => entry.fillPriceUsd !== null && entry.quantity !== null,
    ),
  ).toBe(true);
  expect(data.entries.some((entry) => entry.portfolioId === portfolioA)).toBe(
    true,
  );
  expect(data.entries.some((entry) => entry.portfolioId === portfolioB)).toBe(
    true,
  );
  expect(JSON.stringify(data)).not.toContain('rawPayload');
});

it('uses recording time to exclude old history and future records', async () => {
  expect(
    (await queryPaperEntryAlerts(database.db, '2020-01-01T00:00:00.000Z'))
      .entries,
  ).toEqual([]);
  const future = new Date(Date.now() + 25 * 3600000).toISOString();
  expect((await queryPaperEntryAlerts(database.db, future)).entries).toEqual(
    [],
  );
});

it('distinguishes unqueued, queued, failed and unconfirmed entries without inventing fills', async () => {
  const original = (
    await database.pool.query(
      `SELECT d.* FROM strategy_decisions d WHERE d.run_id=$1 AND d.outcome='BUY_CANDIDATE' LIMIT 1`,
      [strategyA],
    )
  ).rows[0];
  const id = randomUUID(),
    signalId = randomUUID();
  const payload = {
    ...original.payload,
    id,
    candidate: { ...original.payload.candidate, id: signalId },
  };
  await database.pool.query(
    `INSERT INTO strategy_decisions(id,run_id,mode,token_mint,pool_address,timestamp,candle_id,outcome,opportunity_key,signal_id,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,'BUY_CANDIDATE',$8::text,$8::uuid,$9)`,
    [
      id,
      strategyA,
      original.mode,
      original.token_mint,
      original.pool_address,
      original.timestamp,
      original.candle_id,
      signalId,
      payload,
    ],
  );
  const find = async () =>
    (
      await queryPaperEntryAlerts(database.db, new Date().toISOString())
    ).entries.find((entry) => entry.decisionId === id);
  expect((await find())?.status).toBe('CANDIDATE_ONLY');
  const template = (
    await database.pool.query(
      `SELECT i.* FROM backtest_execution_intents i JOIN backtest_runs r ON r.id=i.run_id WHERE r.portfolio_id=$1 AND i.payload->>'kind'='ENTRY' LIMIT 1`,
      [portfolioA],
    )
  ).rows[0];
  const intentId = randomUUID();
  await database.pool.query(
    `INSERT INTO backtest_execution_intents(id,run_id,status,due_at,payload) VALUES($1,$2,'PENDING',$3,$4)`,
    [
      intentId,
      template.run_id,
      template.due_at,
      { ...template.payload, id: intentId, signalId, status: 'PENDING' },
    ],
  );
  expect((await find())?.status).toBe('QUEUED');
  await database.pool.query(
    `UPDATE backtest_execution_intents SET status='FAILED' WHERE id=$1`,
    [intentId],
  );
  expect((await find())?.status).toBe('FAILED');
  await database.pool.query(
    `UPDATE backtest_execution_intents SET status='FILLED' WHERE id=$1`,
    [intentId],
  );
  const unconfirmed = await find();
  expect(unconfirmed?.status).toBe('EXECUTION_UNCERTAIN');
  expect(unconfirmed?.fillPriceUsd).toBeNull();
});
