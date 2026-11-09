import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createRepository,
  marketEvents,
  marketSnapshots,
  migrateDatabase,
  orders,
  positions,
  tokens,
  trades,
  tradingSignals,
} from '../src/index.js';
import type { Database } from '../src/index.js';
import * as schema from '../src/schema.js';
import {
  event,
  id,
  LATER,
  order,
  OTHER_MINT,
  signal,
  snapshot,
  token,
  trade,
} from '../../../tests/fixtures.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
// This guard runs before even constructing a pool. Never fall back to DATABASE_URL.
const testUrl = assertSafeTestDatabase(
  process.env.TEST_DATABASE_URL,
  process.env.DATABASE_URL,
);
const database = createDatabase(testUrl);
let client: PoolClient | undefined;
let db: Database;

beforeAll(async () => {
  await database.verify();
  await migrateDatabase(database.db);
  await migrateDatabase(database.db); // Migration replay must be a no-op.
});
beforeEach(async () => {
  client = await database.pool.connect();
  await client.query('BEGIN');
  db = drizzle(client, { schema });
});
afterEach(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
    client = undefined;
  }
});
afterAll(async () => {
  await database.close();
});

describe('PostgreSQL persistence (transaction-rolled-back fixtures)', () => {
  it('connects with UTC sessions', async () => {
    const result = await db.execute(
      sql`SELECT current_setting('TimeZone') AS timezone`,
    );
    expect(result.rows[0]).toEqual({ timezone: 'UTC' });
  });
  it('inserts tokens with nullable pool addresses', async () => {
    const row = await createRepository(db).insertToken(token);
    expect(row?.mintAddress).toBe(token.mintAddress);
    expect(row?.poolAddress).toBeNull();
    expect(
      await db
        .select()
        .from(tokens)
        .where(eq(tokens.mintAddress, token.mintAddress)),
    ).toHaveLength(1);
  });
  it('inserts events, preserves raw data, and keeps large slots exact', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    const row = await repository.insertMarketEvent(event);
    expect(row?.slot).toBe(9007199254740993n);
    expect(row?.rawPayload).toEqual(event.rawPayload);
  });
  it('deduplicates by source identity and retains multiple events per transaction', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    await repository.insertMarketEvent(event);
    const duplicate = await repository.insertMarketEvent({
      ...event,
      id: id(20),
      rawPayload: { changed: true },
    });
    expect(duplicate).toBeNull();
    await repository.insertMarketEvent({
      ...event,
      id: id(21),
      sourceEventId: 'fixture-tx:0:1',
    });
    const rows = await db
      .select()
      .from(marketEvents)
      .where(eq(marketEvents.tokenMint, token.mintAddress));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === event.id)?.rawPayload).toEqual(
      event.rawPayload,
    );
  });
  it('persists order quantities and fees as exact decimal strings', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    const row = await repository.insertOrder({
      ...order,
      requestedQuantity: '9007199254740993.000000000000000001',
    });
    expect(row?.requestedQuantity).toBe('9007199254740993.000000000000000001');
    expect(row?.submittedAt).toBeNull();
    expect(row?.actualFeesUsd).toBeNull();
  });
  it('persists fills and their associated orders', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    await repository.insertOrder({
      ...order,
      status: 'FILLED',
      submittedAt: order.createdAt,
      executedAt: LATER,
      actualFeesUsd: '0.01',
    });
    const row = await repository.insertTrade(trade);
    expect(row?.executedQuantity).toBe('0.3');
    expect(row?.executionPriceUsd).toBe('0.1');
    expect(
      await db.select().from(trades).where(eq(trades.orderId, order.id)),
    ).toHaveLength(1);
  });
  it('persists snapshots, signals, and signed position P&L', async () => {
    await createRepository(db).insertToken(token);
    await db.insert(marketSnapshots).values(snapshot);
    const { marketSnapshot, ...signalFields } = signal;
    await db
      .insert(tradingSignals)
      .values({ ...signalFields, snapshotId: marketSnapshot.id });
    await db.insert(positions).values({
      id: id(30),
      tokenMint: token.mintAddress,
      quantity: '0.3',
      averageEntryPriceUsd: '0.1',
      costBasisUsd: '0.03',
      realizedPnlUsd: '-0.01',
      unrealizedPnlUsd: '0.02',
      status: 'OPEN',
      openedAt: order.createdAt,
      closedAt: null,
    });
    expect(
      (
        await db
          .select()
          .from(positions)
          .where(eq(positions.id, id(30)))
      )[0]?.realizedPnlUsd,
    ).toBe('-0.01');
    expect(
      (
        await db
          .select()
          .from(tradingSignals)
          .where(eq(tradingSignals.id, signal.id))
      )[0]?.riskAssessment,
    ).toEqual(signal.riskAssessment);
  });
  it('rejects orders referencing unknown tokens', async () => {
    await expect(createRepository(db).insertOrder(order)).rejects.toMatchObject(
      { cause: { code: '23503' } },
    );
  });
  it('rejects trades referencing unknown orders', async () => {
    await createRepository(db).insertToken(token);
    await expect(createRepository(db).insertTrade(trade)).rejects.toMatchObject(
      { cause: { code: '23503' } },
    );
  });
  it('rejects trades with a different token than their order', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    await repository.insertToken({ ...token, mintAddress: OTHER_MINT });
    await repository.insertOrder(order);
    await expect(
      repository.insertTrade({ ...trade, tokenMint: OTHER_MINT }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
  it('rejects signals with a snapshot belonging to another token', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    await repository.insertToken({ ...token, mintAddress: OTHER_MINT });
    await db.insert(marketSnapshots).values(snapshot);
    const { marketSnapshot, ...fields } = signal;
    await expect(
      db.insert(tradingSignals).values({
        ...fields,
        tokenMint: OTHER_MINT,
        snapshotId: marketSnapshot.id,
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
  it('enforces paper-only mode even for direct database writes', async () => {
    await createRepository(db).insertToken(token);
    await expect(
      db.insert(orders).values({ ...order, executionMode: 'LIVE' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it('enforces positive monetary quantities on direct writes', async () => {
    await createRepository(db).insertToken(token);
    await expect(
      db.insert(orders).values({ ...order, requestedQuantity: '-1' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it('enforces order lifecycle constraints on direct writes', async () => {
    await createRepository(db).insertToken(token);
    await expect(
      db.insert(orders).values({ ...order, status: 'FILLED' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it.each(['0.0000000000000000001', `1${'0'.repeat(60)}`, 'NaN', 'Infinity'])(
    'rejects unrepresentable database monetary amount %s',
    async (amount) => {
      await createRepository(db).insertToken(token);
      await expect(
        db.insert(orders).values({ ...order, requestedQuantity: amount }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    },
  );
  it('protects referenced tokens from deletion', async () => {
    const repository = createRepository(db);
    await repository.insertToken(token);
    await repository.insertOrder(order);
    await expect(
      db.delete(tokens).where(eq(tokens.mintAddress, token.mintAddress)),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});
