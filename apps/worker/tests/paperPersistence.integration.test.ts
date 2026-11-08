import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as databaseSchema from '@solemn/database';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createPaperRepository,
  createStrategyRepository,
  migrateDatabase,
  orders,
  paperPortfolios,
  portfolioBalanceEvents,
  positions,
  trades,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableId } from '@solemn/shared';
import { replayPaperTrading } from '../src/portfolio/paperReplay.js';
import { createPaperReplayFixture } from '../src/portfolio/replayFixture.js';
import { recoverPortfolio } from '../src/portfolio/recovery.js';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import { replayStrategy } from '../src/strategy/replay.js';
import {
  initialPortfolio,
  initialPosting,
} from '../src/portfolio/accountingService.js';
import { paperDefinition } from '../src/portfolio/paperReplay.js';
import { paperConfig } from './paperFixtures.js';
dotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const database = createDatabase(
  assertSafeTestDatabase(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  ),
);
beforeAll(async () => {
  await migrateDatabase(database.db);
});
afterAll(async () => {
  await database.close();
});
async function rolledBack(test: (tx: Database) => Promise<void>) {
  const rollback = new Error('ROLLBACK_PAPER_TEST');
  try {
    await database.db.transaction(async (tx) => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
describe('durable paper accounting', () => {
  it(
    'persists an auditable signal-to-position-to-close cycle and recovers identical state after retries/restart',
    async () =>
      rolledBack(async (tx) => {
        const repository = createPaperRepository(tx),
          strategy = createStrategyRepository(tx),
          fixture = createPaperReplayFixture(paperConfig);
        const result = await replayPaperTrading(
          fixture,
          paperConfig,
          strategy,
          repository,
        );
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        expect(
          await tx
            .select({ n: count() })
            .from(orders)
            .where(eq(orders.portfolioId, result.definition.id)),
        ).toEqual([{ n: 4 }]);
        expect(
          await tx
            .select({ n: count() })
            .from(trades)
            .where(eq(trades.portfolioId, result.definition.id)),
        ).toEqual([{ n: 4 }]);
        const persisted = (
          await tx
            .select()
            .from(positions)
            .where(eq(positions.portfolioId, result.definition.id))
        )[0]!;
        expect(persisted.status).toBe('CLOSED');
        expect(persisted.quantity).toBe('0');
        expect(persisted.paperDetails).toEqual(result.state.positions[0]);
        const restarted = createPaperRepository(tx);
        expect(
          (await recoverPortfolio(restarted, result.definition.id)).state,
        ).toEqual(result.state);
        const repeated = await replayPaperTrading(
          fixture,
          paperConfig,
          strategy,
          restarted,
        );
        expect(repeated.duplicates).toBe(6);
        expect(repeated.state).toEqual(result.state);
        expect(
          await tx
            .select({ n: count() })
            .from(portfolioBalanceEvents)
            .where(
              eq(portfolioBalanceEvents.portfolioId, result.definition.id),
            ),
        ).toEqual([{ n: 7 }]);
      }),
    20000,
  );
  it(
    'retains failed exits, remaining cost basis and halted/blocked state across restart',
    async () =>
      rolledBack(async (tx) => {
        const repository = createPaperRepository(tx),
          fixture = createPaperReplayFixture(paperConfig, 'blocked-stop');
        const result = await replayPaperTrading(
          fixture,
          paperConfig,
          createStrategyRepository(tx),
          repository,
        );
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const rows = await tx
          .select()
          .from(orders)
          .where(eq(orders.portfolioId, result.definition.id));
        expect(rows.map((row) => row.status).sort()).toEqual([
          'FAILED',
          'FILLED',
        ]);
        expect(
          await tx
            .select({ n: count() })
            .from(trades)
            .where(eq(trades.portfolioId, result.definition.id)),
        ).toEqual([{ n: 1 }]);
        const recovered = await recoverPortfolio(
          createPaperRepository(tx),
          result.definition.id,
        );
        expect(recovered.state.positions[0]).toMatchObject({
          status: 'EXIT_BLOCKED',
          pendingExitReason: 'STOP_LOSS',
          closedAt: null,
        });
        expect(recovered.state.positions[0]!.costBasisUsd).toBe(
          recovered.state.positions[0]!.initialCostBasisUsd,
        );
      }),
    15000,
  );
  it(
    'rolls back failed materialization without changing balance, journal, orders or positions',
    async () =>
      rolledBack(async (tx) => {
        const repository = createPaperRepository(tx),
          fixture = createPaperReplayFixture(paperConfig);
        const result = await replayPaperTrading(
          fixture,
          paperConfig,
          createStrategyRepository(tx),
          repository,
        );
        const before = await repository.load(result.definition.id),
          countBefore = (await repository.history(result.definition.id)).length;
        const command = {
          type: 'HALT' as const,
          id: stableId(['rollback-paper']),
          at: '2026-01-01T00:20:00.000Z',
          reason: 'TEST_ROLLBACK',
        };
        await expect(
          repository.transact(
            result.definition.id,
            command,
            (state, definition) => {
              const transition = applyPaperCommand(state, command, definition);
              transition.state.availableCashUsd = '999';
              return transition;
            },
          ),
        ).rejects.toThrow('posting totals');
        expect(await repository.load(result.definition.id)).toEqual(before);
        expect((await repository.history(result.definition.id)).length).toBe(
          countBefore,
        );
      }),
    15000,
  );
  it(
    'enforces append-only journals and prevents unrecorded balance changes in PostgreSQL',
    async () =>
      rolledBack(async (tx) => {
        const repository = createPaperRepository(tx),
          result = await replayPaperTrading(
            createPaperReplayFixture(paperConfig),
            paperConfig,
            createStrategyRepository(tx),
            repository,
          );
        let code: unknown;
        try {
          await tx.transaction(async (nested) => {
            await nested
              .update(portfolioBalanceEvents)
              .set({ inputHash: 'tampered' })
              .where(
                eq(portfolioBalanceEvents.portfolioId, result.definition.id),
              );
          });
        } catch (error) {
          code = (error as { cause?: { code?: string } }).cause?.code;
        }
        expect(code).toBe('23514');
        code = undefined;
        try {
          await tx.transaction(async (nested) => {
            await nested
              .update(paperPortfolios)
              .set({
                state: { ...result.state, availableCashUsd: '999' },
                availableCashUsd: '999',
              })
              .where(eq(paperPortfolios.id, result.definition.id));
            await nested.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          });
        } catch (error) {
          code = (error as { cause?: { code?: string } }).cause?.code;
        }
        expect(code).toBe('23514');
      }),
    15000,
  );
  it('serializes concurrent duplicate entries across independent PostgreSQL connections', async () => {
    // A private disposable schema permits real commits without contaminating shared test fixtures.
    const schemaName = `solemn_paper_race_${randomUUID().replaceAll('-', '')}`;
    const names = [
      'strategy_runs',
      'market_trade_observations',
      'market_coverage_observations',
      'market_candles',
      'market_corrections',
      'strategy_decisions',
      'paper_portfolios',
      'portfolio_balance_events',
      'tokens',
      'positions',
      'orders',
      'trades',
    ];
    const first = await database.pool.connect(),
      second = await database.pool.connect();
    try {
      await first.query(`CREATE SCHEMA "${schemaName}"`);
      for (const name of names)
        await first.query(
          `CREATE TABLE "${schemaName}"."${name}" (LIKE public."${name}" INCLUDING ALL)`,
        );
      await first.query(`SET search_path TO "${schemaName}", public`);
      await second.query(`SET search_path TO "${schemaName}", public`);
      const dbA = drizzle(first, { schema: databaseSchema }),
        dbB = drizzle(second, { schema: databaseSchema });
      const fixture = createPaperReplayFixture(paperConfig);
      const replay = await replayStrategy(
        fixture.marketDataset,
        paperConfig,
        createStrategyRepository(dbA),
      );
      const definition = paperDefinition(paperConfig, replay.run.id, fixture),
        repoA = createPaperRepository(dbA),
        repoB = createPaperRepository(dbB);
      await repoA.initialize(
        definition,
        initialPortfolio(definition),
        initialPosting(definition),
      );
      const decision = replay.decisions.find((item) => item.candidate)!;
      const command = {
        type: 'ENTRY' as const,
        id: stableId(['paper-entry-v1', definition.id, decision.candidate!.id]),
        at: decision.timestamp,
        candidate: decision.candidate!,
        risk: decision.risk,
        observation: fixture.observations[0]!,
      };
      const outcomes = await Promise.all(
        [repoA, repoB].map((repository) =>
          repository.transact(definition.id, command, (state, account) =>
            applyPaperCommand(state, command, account),
          ),
        ),
      );
      expect(outcomes.map((outcome) => outcome.duplicate).sort()).toEqual([
        false,
        true,
      ]);
      expect(await dbA.select({ n: count() }).from(orders)).toEqual([{ n: 1 }]);
      expect(await dbA.select({ n: count() }).from(trades)).toEqual([{ n: 1 }]);
      const recovered = await recoverPortfolio(repoB, definition.id);
      expect(recovered.state.positions).toHaveLength(1);
      expect(recovered.state.reservedCashUsd).toBe('0');
      expect((await repoA.history(definition.id)).length).toBe(2);
    } finally {
      await first.query('SET search_path TO public');
      await second.query('SET search_path TO public');
      first.release();
      second.release();
      await database.pool.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
      );
    }
  }, 20000);
  it(
    'atomically rolls back an invalid fill after order/position insertion and checks materialized recovery records',
    async () =>
      rolledBack(async (tx) => {
        const fixture = createPaperReplayFixture(paperConfig);
        const strategy = await replayStrategy(
          fixture.marketDataset,
          paperConfig,
          createStrategyRepository(tx),
        );
        const definition = paperDefinition(
            paperConfig,
            strategy.run.id,
            fixture,
          ),
          repository = createPaperRepository(tx);
        await repository.initialize(
          definition,
          initialPortfolio(definition),
          initialPosting(definition),
        );
        const decision = strategy.decisions.find((item) => item.candidate)!;
        const command = {
          type: 'ENTRY' as const,
          id: stableId([
            'paper-entry-v1',
            definition.id,
            decision.candidate!.id,
          ]),
          at: decision.timestamp,
          candidate: decision.candidate!,
          risk: decision.risk,
          observation: fixture.observations[0]!,
        };
        await expect(
          repository.transact(definition.id, command, (state, account) => {
            const transition = applyPaperCommand(state, command, account);
            transition.orders[0]!.trades[0]!.feesUsd = '999';
            return transition;
          }),
        ).rejects.toThrow('does not reconcile');
        expect(
          (await repository.load(definition.id)).state.availableCashUsd,
        ).toBe('100');
        expect(
          await tx
            .select({ n: count() })
            .from(orders)
            .where(eq(orders.portfolioId, definition.id)),
        ).toEqual([{ n: 0 }]);
        expect(
          await tx
            .select({ n: count() })
            .from(positions)
            .where(eq(positions.portfolioId, definition.id)),
        ).toEqual([{ n: 0 }]);
        expect((await repository.history(definition.id)).length).toBe(1);
        await repository.transact(definition.id, command, (state, account) =>
          applyPaperCommand(state, command, account),
        );
        await tx
          .update(positions)
          .set({ unrealizedPnlUsd: '999' })
          .where(eq(positions.portfolioId, definition.id));
        await expect(
          recoverPortfolio(repository, definition.id),
        ).rejects.toThrow('materialization mismatch');
      }),
    15000,
  );
});
