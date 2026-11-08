import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createStrategyRepository,
  listFixtureBuyCandidates,
  marketCandles,
  marketCorrections,
  strategyRun,
  marketTradeObservations,
  migrateDatabase,
  orders,
  strategyDecisions,
  strategyRuns,
  tokens,
  trades,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableId } from '@solemn/shared';
import { strategyPolicy } from '../src/strategy/signalEngine.js';
import { policyHash, riskPolicy } from '../src/risk/tokenRiskEngine.js';
import { replayStrategy } from '../src/strategy/replay.js';
import {
  replayTime,
  createReplayFixture,
} from '../src/strategy/replayFixture.js';
import { strategyConfig } from './strategyFixtures.js';
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
  const rollback = new Error('ROLLBACK_STRATEGY_TEST');
  try {
    await database.db.transaction(async (tx) => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
describe('Week 4 persisted vertical slice', () => {
  it(
    'preserves normalized inputs, exact candles, reasons, unique candidates and versioned history without orders or canonical fixture tokens',
    async () =>
      rolledBack(async (tx) => {
        const baseline = {
          orders: await tx.select({ n: count() }).from(orders),
          trades: await tx.select({ n: count() }).from(trades),
          tokens: await tx.select({ n: count() }).from(tokens),
        };
        const repository = createStrategyRepository(tx),
          fixture = createReplayFixture(strategyConfig);
        const result = await replayStrategy(
          fixture,
          strategyConfig,
          repository,
        );
        expect(
          await tx
            .select({ n: count() })
            .from(strategyDecisions)
            .where(eq(strategyDecisions.runId, result.run.id)),
        ).toEqual([{ n: 90 }]);
        expect(
          await tx
            .select({ n: count() })
            .from(marketCandles)
            .where(eq(marketCandles.runId, result.run.id)),
        ).toEqual([{ n: 90 }]);
        expect(
          await tx
            .select({ n: count() })
            .from(marketTradeObservations)
            .where(eq(marketTradeObservations.runId, result.run.id)),
        ).toEqual([{ n: 1080 }]);
        const candidates = await listFixtureBuyCandidates(
          tx,
          result.run.id,
          true,
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toEqual(
          result.decisions.find((decision) => decision.candidate)?.candidate,
        );
        await expect(
          listFixtureBuyCandidates(tx, result.run.id, false),
        ).rejects.toThrow('explicit opt-in');
        const again = await replayStrategy(fixture, strategyConfig, repository);
        expect(again.metrics.duplicateDecisions).toBe(90);
        const updated = await replayStrategy(
          fixture,
          { ...strategyConfig, STRATEGY_VERSION: '1.0.1' },
          repository,
        );
        expect(updated.run.id).not.toBe(result.run.id);
        expect(
          await tx
            .select({ n: count() })
            .from(strategyRuns)
            .where(eq(strategyRuns.id, result.run.id)),
        ).toEqual([{ n: 1 }]);
        expect(await tx.select({ n: count() }).from(orders)).toEqual(
          baseline.orders,
        );
        expect(await tx.select({ n: count() }).from(trades)).toEqual(
          baseline.trades,
        );
        expect(await tx.select({ n: count() }).from(tokens)).toEqual(
          baseline.tokens,
        );
      }),
    20000,
  );
  it(
    'persists late corrections while retaining the original candle',
    async () =>
      rolledBack(async (tx) => {
        const fixture = createReplayFixture(strategyConfig);
        fixture.markets = fixture.markets.slice(0, 1);
        const market = fixture.markets[0]!,
          sourceEventId = 'integration-late';
        market.trades.push({
          ...market.trades[0]!,
          id: stableId(['market-trade', 'SOLEMN_FIXTURE', sourceEventId]),
          sourceEventId,
          receivedAt: replayTime(14),
        });
        const result = await replayStrategy(
          fixture,
          strategyConfig,
          createStrategyRepository(tx),
        );
        expect(result.metrics.buyCandidates).toBe(0);
        expect(
          await tx
            .select({ n: count() })
            .from(marketCorrections)
            .where(eq(marketCorrections.runId, result.run.id)),
        ).toEqual([{ n: 1 }]);
        const first = await tx
          .select()
          .from(marketCandles)
          .where(eq(marketCandles.runId, result.run.id));
        expect(
          first.find((row) => row.payload.startTime === replayTime(0))?.payload
            .tradeCount,
        ).toBe(12);
      }),
    10000,
  );
  it(
    'rejects live BUY payloads at both repository and PostgreSQL boundaries',
    async () =>
      rolledBack(async (tx) => {
        const fixture = createReplayFixture(strategyConfig),
          repository = createStrategyRepository(tx);
        const result = await replayStrategy(
          fixture,
          strategyConfig,
          repository,
        );
        const run = strategyRun(
          strategyPolicy(strategyConfig),
          policyHash(riskPolicy(strategyConfig)),
          null,
        );
        await repository.begin(run);
        const decision = {
          ...result.decisions.find((item) => item.candidate)!,
          runId: run.id,
          candleId: null,
        };
        await expect(repository.save(run, decision, [], [])).rejects.toThrow(
          'NOT_READY',
        );
        let code: unknown;
        try {
          await tx.transaction(async (nested) => {
            await nested.insert(strategyDecisions).values({
              id: stableId(['invalid-live-buy']),
              runId: run.id,
              mode: 'LIVE_NOT_READY',
              tokenMint: decision.mint,
              poolAddress: decision.poolAddress,
              timestamp: decision.timestamp,
              candleId: null,
              outcome: 'BUY_CANDIDATE',
              opportunityKey: decision.candidate!.opportunityKey,
              signalId: stableId(['invalid-live-signal']),
              payload: decision,
            });
          });
        } catch (error) {
          code = (error as { cause?: { code?: unknown } }).cause?.code;
        }
        expect(code).toBe('23514');
      }),
    15000,
  );
});
