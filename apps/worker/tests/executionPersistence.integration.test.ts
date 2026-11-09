import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assertSafeTestDatabase,
  createDatabase,
  migrateDatabase,
  createHistoryRepository,
  createPaperRepository,
  createStrategyRepository,
  createBacktestRepository,
  executionSimulationAttempts,
  backtestScenarios,
  orders,
  trades,
} from '@solemn/database';
import { stableHash, stableId, toAtomic, fromAtomic } from '@solemn/shared';
import { createStressFixture } from '../src/backtesting/stressScenarios.js';
import { executionScenario } from '../src/execution/simulation/executionScenarios.js';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
} from '../src/backtesting/historicalDataProvider.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { backtestConfig } from './backtestFixtures.js';
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
it('atomically persists/reconciles attempts and failure fees, and never duplicates cached runs', async () => {
  const rollback = new Error('ROLLBACK_WEEK7');
  try {
    await database.db.transaction(async (tx) => {
      const history = createHistoryRepository(tx),
        file = createStressFixture(backtestConfig);
      const dataset = await history.register(
        file.manifest,
        historyEvents(file.events),
        1000,
        1000000,
      );
      const plan = createBacktestPlan(
        { dataset: 'fixtures', execution: executionScenario('baseline') },
        dataset,
        backtestConfig,
      );
      const provider = new PostgresHistoricalDataProvider(dataset, history),
        services = {
          paper: createPaperRepository(tx),
          strategy: createStrategyRepository(tx),
          backtests: createBacktestRepository(tx),
        };
      const result = await runBacktest(
        plan,
        provider,
        backtestConfig,
        services,
      );
      const attempts = await tx
        .select()
        .from(executionSimulationAttempts)
        .where(eq(executionSimulationAttempts.runId, plan.runId));
      expect(attempts.length).toBe(result.metrics.execution!.attempts);
      expect(attempts.some((a) => a.outcome === 'FAILED_ON_CHAIN')).toBe(true);
      const fills = await tx
        .select()
        .from(trades)
        .where(eq(trades.portfolioId, plan.portfolioId));
      const storedOrders = await tx
        .select()
        .from(orders)
        .where(eq(orders.portfolioId, plan.portfolioId));
      expect(fills.length).toBe(
        attempts.filter((a) => a.outcome === 'FILLED').length,
      );
      for (const a of attempts.filter((a) => a.outcome !== 'FILLED'))
        expect(fills.some((f) => f.orderId === a.orderId)).toBe(false);
      expect(storedOrders.length).toBe(attempts.length);
      const signed = (s: string) =>
        s.startsWith('-') ? -toAtomic(s.slice(1)) : toAtomic(s);
      expect(
        fromAtomic(
          toAtomic(result.finalState.availableCashUsd) +
            toAtomic(result.finalState.reservedCashUsd) +
            toAtomic(result.finalState.investedCostBasisUsd),
        ),
      ).toBe(
        fromAtomic(toAtomic('100') + signed(result.finalState.realizedPnlUsd)),
      );
      const repeat = await runBacktest(
        plan,
        provider,
        backtestConfig,
        services,
      );
      expect(stableHash(repeat)).toBe(stableHash(result));
      expect(
        (
          await tx
            .select()
            .from(executionSimulationAttempts)
            .where(eq(executionSimulationAttempts.runId, plan.runId))
        ).length,
      ).toBe(attempts.length);
      expect(
        stableHash((await services.paper.snapshot(plan.portfolioId)).state),
      ).toBe(stableHash(result.finalState));
      await expect(
        tx.transaction(async (nested) => {
          await nested
            .update(executionSimulationAttempts)
            .set({ outcome: 'FILLED' })
            .where(eq(executionSimulationAttempts.id, attempts[0]!.id));
        }),
      ).rejects.toThrow();
      // Completed runs can be reused by independent comparison experiments.
      await tx.insert(backtestScenarios).values(
        ['a', 'b'].map((key) => ({
          id: stableId(['scenario-membership-test', key]),
          experimentId: stableId(['experiment-test', key]),
          runId: plan.runId,
          name: 'baseline',
          configuration: plan.execution!,
        })),
      );
      expect(
        (
          await tx
            .select()
            .from(backtestScenarios)
            .where(eq(backtestScenarios.runId, plan.runId))
        ).length,
      ).toBe(2);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}, 120000);
