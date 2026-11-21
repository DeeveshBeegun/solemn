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
