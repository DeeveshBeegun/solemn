import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createRepository,
  migrateDatabase,
  enforceDatabaseStorage,
  createHistoryRepository,
  createBacktestRepository,
  createPaperRepository,
  createStrategyRepository,
} from '@solemn/database';
import { token, event } from '../../../tests/fixtures.js';
import { backtestConfig } from './backtestFixtures.js';
import { createBacktestFixture } from '../src/backtesting/replayFixture.js';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
} from '../src/backtesting/historicalDataProvider.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { createLogger } from '../src/services/logger.js';
import { forwardPortfolioId } from '../src/forward/account.js';
import { createReplayProvider } from '../src/forward/replayProvider.js';
import { runForwardReplay } from '../src/forward/replayCoordinator.js';

dotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const testUrl = assertSafeTestDatabase(
  process.env.TEST_DATABASE_URL,
  process.env.DATABASE_URL,
);
const control = createDatabase(testUrl, undefined, {
  storageMaintenance: false,
});
let scratch: string;
let database: ReturnType<typeof createDatabase>;
beforeEach(async () => {
  scratch = 'solemn_storage_' + randomUUID().replaceAll('-', '');
  await control.pool.query('CREATE DATABASE "' + scratch + '"');
  const url = new URL(testUrl);
  url.pathname = '/' + scratch;
  database = createDatabase(url.href, undefined, { storageMaintenance: false });
  await migrateDatabase(database.db);
});
afterEach(async () => {
  await database?.close();
  if (scratch)
    await control.pool.query('DROP DATABASE "' + scratch + '" WITH (FORCE)');
});
afterAll(async () => {
  await control.close();
});

async function capForTest() {
  await database.pool.query(
    'UPDATE public.solemn_storage_policy SET limit_bytes=2, target_bytes=1 WHERE singleton',
  );
}

it('installs a decimal 5 GB cap across every application table and supports migration replay', async () => {
  await migrateDatabase(database.db);
  const policy = await database.pool.query(
    'SELECT limit_bytes,target_bytes FROM public.solemn_storage_policy',
  );
  expect(policy.rows).toEqual([
    { limit_bytes: '5000000000', target_bytes: '4500000000' },
  ]);
  const uncovered = await database.pool.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'solemn_storage_policy'
      AND (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgenabled='O'
        AND t.tgname IN ('solemn_storage_limit_before','solemn_storage_limit_after')) <> 2
  `);
  expect(uncovered.rows).toEqual([]);
  expect((await enforceDatabaseStorage(database.pool)).status).toBe(
    'BELOW_LIMIT',
  );
});

it('blocks writes at the cap, removes old discovery rows, reclaims their table, and preserves recent data', async () => {
  const repository = createRepository(database.db);
  await repository.insertToken(token);
  const oldId = randomUUID(),
    recentId = randomUUID();
  await repository.insertMarketEvent({
    ...event,
    id: oldId,
    sourceEventId: oldId,
    ingestedAt: '2000-01-01T00:00:00.000Z',
  });
  await repository.insertMarketEvent({
    ...event,
    id: recentId,
    sourceEventId: recentId,
    ingestedAt: new Date().toISOString(),
  });
  await capForTest();
  await expect(
    database.pool.query('UPDATE tokens SET name=name'),
  ).rejects.toMatchObject({
    code: '53100',
    message: 'SOLEMN_DATABASE_STORAGE_LIMIT_REACHED',
  });
  await expect(
    repository.insertMarketEvent({
      ...event,
      id: randomUUID(),
      sourceEventId: randomUUID(),
    }),
  ).rejects.toMatchObject({ cause: { code: '53100' } });
  const url = new URL(testUrl);
  url.pathname = '/' + scratch;
  const automatic = createDatabase(url.href);
  try {
    await automatic.verify();
  } finally {
    await automatic.close();
  }
  const cleaned = (
    await database.pool.query(
      'SELECT last_status, deleted_rows FROM public.solemn_storage_policy',
    )
  ).rows[0];
  expect(cleaned).toEqual({
    last_status: 'NO_ELIGIBLE_DATA',
    deleted_rows: '1',
  });
  expect(
    (await database.pool.query('SELECT id FROM market_events')).rows,
  ).toEqual([{ id: recentId }]);
  expect(
    (
      await database.pool.query(
        'SELECT pending_tables FROM public.solemn_storage_policy',
      )
    ).rows[0].pending_tables,
  ).toEqual([]);
});

it('removes an expired completed backtest bundle atomically and protects a running backtest', async () => {
  const file = createBacktestFixture(backtestConfig, 'winner');
  const history = createHistoryRepository(database.db);
  const dataset = await history.register(
    file.manifest,
    historyEvents(file.events),
    100,
    100000,
  );
  const plan = createBacktestPlan(
    { dataset: 'fixtures', runId: randomUUID() },
    dataset,
    backtestConfig,
  );
  const completed = await runBacktest(
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
  expect(completed.metrics.trading.filledOrders).toBeGreaterThan(0);
  expect(completed.metrics.strategy.positionsRemainingOpen).toBe(0);
  const activePlan = createBacktestPlan(
    { dataset: 'fixtures', runId: randomUUID() },
    dataset,
    backtestConfig,
  );
  await runBacktest(
    activePlan,
    new PostgresHistoricalDataProvider(dataset, history),
    backtestConfig,
    {
      paper: createPaperRepository(database.db),
      strategy: createStrategyRepository(database.db),
      backtests: createBacktestRepository(database.db),
    },
    createLogger('silent'),
  );
  await database.pool.query(
    "UPDATE backtest_runs SET created_at='2000-01-01', completed_at='2000-01-01'",
  );
  await database.pool.query(
    "UPDATE backtest_runs SET status='RUNNING' WHERE id=$1",
    [activePlan.runId],
  );
  await capForTest();
  const result = await enforceDatabaseStorage(database.pool);
  expect(result.deletedRows).toBeGreaterThan(0);
  expect(
    (await database.pool.query('SELECT id FROM backtest_runs')).rows,
  ).toEqual([{ id: activePlan.runId }]);
  expect(
    (
      await database.pool.query('SELECT id FROM paper_portfolios WHERE id=$1', [
        completed.plan.portfolioId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        'SELECT count(*)::int AS n FROM portfolio_balance_events',
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'",
      )
    ).rows[0].n,
  ).toBe(0);
}, 30000);

it('resumes a pending compaction before deleting more data and excludes competing cleanup owners', async () => {
  const holder = await database.pool.connect();
  try {
    await holder.query(
      "SELECT pg_advisory_lock(hashtextextended('solemn-database-storage-retention-v1',0))",
    );
    await capForTest();
    expect((await enforceDatabaseStorage(database.pool)).status).toBe('BUSY');
  } finally {
    holder.release(true);
  }
  await database.pool.query(
    "UPDATE public.solemn_storage_policy SET limit_bytes=5000000000,target_bytes=4500000000,cleanup_active=true,pending_tables=ARRAY['market_events']",
  );
  expect((await enforceDatabaseStorage(database.pool)).status).toBe('CLEANED');
  const state = (
    await database.pool.query(
      'SELECT cleanup_active,pending_tables FROM public.solemn_storage_policy',
    )
  ).rows[0];
  expect(state).toEqual({ cleanup_active: false, pending_tables: [] });
});

it('protects a stopped forward account while a worker owns it, then removes the complete old account', async () => {
  const config = {
    ...backtestConfig,
    FORWARD_PAPER_ENABLED: true,
    FORWARD_MARKET_DATA_MODE: 'REPLAY' as const,
    FORWARD_ACCOUNT: 'retention-owner',
  };
  const id = forwardPortfolioId(config);
  const lease = await database.acquireForwardOwnership(id);
  try {
    const stop = new AbortController();
    stop.abort();
    await runForwardReplay(
      lease.db,
      config,
      createReplayProvider(config),
      createLogger('silent'),
      stop.signal,
    );
    await database.pool.query(
      "UPDATE forward_accounts SET heartbeat_at='2000-01-01' WHERE portfolio_id=$1",
      [id],
    );
    await capForTest();
    const protectedResult = await enforceDatabaseStorage(database.pool);
    expect(protectedResult.status).toBe('NO_ELIGIBLE_DATA');
    expect(protectedResult.deletedRows).toBe(0);
    expect(
      (await database.pool.query('SELECT portfolio_id FROM forward_accounts'))
        .rows,
    ).toEqual([{ portfolio_id: id }]);
  } finally {
    lease.release();
  }
  const removed = await enforceDatabaseStorage(database.pool);
  expect(removed.deletedRows).toBeGreaterThan(0);
  expect(
    (await database.pool.query('SELECT id FROM paper_portfolios')).rows,
  ).toEqual([]);
  expect(
    (await database.pool.query('SELECT portfolio_id FROM forward_accounts'))
      .rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'",
      )
    ).rows[0].n,
  ).toBe(0);
});

it('keeps a completed backtest with an unresolved position even when it is old', async () => {
  const source = createBacktestFixture(backtestConfig);
  const history = createHistoryRepository(database.db);
  const dataset = await history.register(
    source.manifest,
    historyEvents(source.events),
    100,
    100000,
  );
  const plan = createBacktestPlan(
    { dataset: 'fixtures', runId: randomUUID() },
    dataset,
    backtestConfig,
  );
  const result = await runBacktest(
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
  expect(result.metrics.strategy.positionsRemainingOpen).toBeGreaterThan(0);
  await database.pool.query(
    "UPDATE backtest_runs SET created_at='2000-01-01', completed_at='2000-01-01'",
  );
  await capForTest();
  const protectedResult = await enforceDatabaseStorage(database.pool);
  expect(protectedResult.status).toBe('NO_ELIGIBLE_DATA');
  expect(protectedResult.deletedRows).toBe(0);
  expect(
    (await database.pool.query('SELECT id FROM backtest_runs')).rows,
  ).toEqual([{ id: plan.runId }]);
}, 30000);

it('rolls back a statement that crosses the storage limit after it starts writing', async () => {
  const measured = await database.pool.query(
    'SELECT pg_database_size(current_database())::text AS bytes',
  );
  const before = BigInt(measured.rows[0].bytes);
  const limit = before + 100000n;
  await database.pool.query(
    'UPDATE public.solemn_storage_policy SET target_bytes=$1,limit_bytes=$2',
    [before.toString(), limit.toString()],
  );
  const payload = randomBytes(512000).toString('hex');
  await expect(
    database.pool.query(
      'INSERT INTO scanner_gaps (id,source,started_at,ended_at,reason) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), 'storage-test', '2000-01-01', '2000-01-02', payload],
    ),
  ).rejects.toMatchObject({
    code: '53100',
    message: 'SOLEMN_DATABASE_STORAGE_LIMIT_REACHED',
  });
  expect(
    (await database.pool.query('SELECT count(*)::int AS n FROM scanner_gaps'))
      .rows[0].n,
  ).toBe(0);
});

it('removes unused old token metadata and its latest-assessment FK cycle together', async () => {
  await createRepository(database.db).insertToken({
    ...token,
    discoveredAt: '2000-01-01T00:00:00.000Z',
  });
  const assessment = randomUUID();
  await database.pool.query(
    `
    INSERT INTO token_risk_assessments
      (id,token_mint,request_id,attempt,requested_at,status,reasons,checks,policy,policy_version,policy_hash,evidence,assessed_at)
    VALUES ($1,$2,$3,1,'2000-01-01','UNKNOWN','[]','{}','{}','retention-test','retention-test','{}','2000-01-01')
  `,
    [assessment, token.mintAddress, randomUUID()],
  );
  await database.pool.query(
    'UPDATE tokens SET latest_risk_assessment_id=$1 WHERE mint_address=$2',
    [assessment, token.mintAddress],
  );
  await capForTest();
  const result = await enforceDatabaseStorage(database.pool);
  expect(result.deletedRows).toBe(2);
  expect(
    (await database.pool.query('SELECT mint_address FROM tokens')).rows,
  ).toEqual([]);
  expect(
    (await database.pool.query('SELECT id FROM token_risk_assessments')).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'",
      )
    ).rows[0].n,
  ).toBe(0);
});
