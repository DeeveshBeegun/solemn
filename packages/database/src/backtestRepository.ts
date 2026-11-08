import { and, asc, eq, gt } from 'drizzle-orm';
import {
  equitySnapshotSchema,
  executionIntentSchema,
  stableHash,
} from '@solemn/shared';
import type {
  BacktestPlan,
  BacktestResult,
  EquitySnapshot,
  ExecutionIntent,
} from '@solemn/shared';
import type { Database } from './client.js';
import {
  backtestRuns,
  backtestResults,
  backtestEquitySnapshots,
  backtestExecutionIntents,
} from './backtestSchema.js';
import { portfolioBalanceEvents } from './paperSchema.js';
export interface BacktestRepository {
  start(plan: BacktestPlan): Promise<BacktestResult | null>;
  attach(plan: BacktestPlan): Promise<void>;
  equity(snapshot: EquitySnapshot): Promise<void>;
  intent(intent: ExecutionIntent): Promise<void>;
  complete(result: BacktestResult): Promise<void>;
  fail(runId: string, cancelled: boolean): Promise<void>;
  result(runId: string): Promise<BacktestResult>;
  equitySeries(runId: string, batchSize: number): AsyncIterable<EquitySnapshot>;
  intents(runId: string, batchSize: number): AsyncIterable<ExecutionIntent>;
  ledger(
    portfolioId: string,
    batchSize: number,
  ): AsyncIterable<typeof portfolioBalanceEvents.$inferSelect>;
}
export function createBacktestRepository(db: Database): BacktestRepository {
  return {
    async start(plan) {
      return db.transaction(async (tx) => {
        await tx
          .insert(backtestRuns)
          .values({
            id: plan.runId,
            datasetId: plan.datasetId,
            datasetFingerprint: plan.datasetFingerprint,
            configHash: stableHash(plan),
            plan,
            status: 'RUNNING',
          })
          .onConflictDoNothing();
        const run = (
          await tx
            .select()
            .from(backtestRuns)
            .where(eq(backtestRuns.id, plan.runId))
            .for('update')
        )[0]!;
        if (run.configHash !== stableHash(plan))
          throw new Error('Backtest run configuration is immutable');
        const result = (
          await tx
            .select()
            .from(backtestResults)
            .where(eq(backtestResults.runId, plan.runId))
        )[0];
        if (result) return result.payload;
        await tx
          .update(backtestRuns)
          .set({ status: 'RUNNING', errorCode: null, completedAt: null })
          .where(eq(backtestRuns.id, plan.runId));
        return null;
      });
    },
    async attach(plan) {
      await db
        .update(backtestRuns)
        .set({
          portfolioId: plan.portfolioId,
          strategyRunId: plan.strategyRunId,
        })
        .where(eq(backtestRuns.id, plan.runId));
    },
    async equity(input) {
      const snapshot = equitySnapshotSchema.parse(input);
      const inserted = await db
        .insert(backtestEquitySnapshots)
        .values({ ...snapshot, payload: snapshot })
        .onConflictDoNothing()
        .returning({ id: backtestEquitySnapshots.id });
      if (!inserted.length) {
        const existing = (
          await db
            .select()
            .from(backtestEquitySnapshots)
            .where(eq(backtestEquitySnapshots.id, snapshot.id))
        )[0];
        if (!existing || stableHash(existing.payload) !== stableHash(snapshot))
          throw new Error('Backtest equity replay mismatch');
      }
    },
    async intent(input) {
      const intent = executionIntentSchema.parse(input);
      await db.transaction(async (tx) => {
        const existing = (
          await tx
            .select()
            .from(backtestExecutionIntents)
            .where(eq(backtestExecutionIntents.id, intent.id))
            .for('update')
        )[0];
        if (existing) {
          if (stableHash(existing.payload) === stableHash(intent)) return;
          // Reconstructing a previously processed run may revisit an earlier PENDING state.
          if (intent.status === 'PENDING' && existing.status !== 'PENDING')
            return;
          if (existing.status !== 'PENDING')
            throw new Error('Backtest execution intent replay mismatch');
          await tx
            .update(backtestExecutionIntents)
            .set({
              status: intent.status,
              dueAt: intent.dueAt,
              payload: intent,
            })
            .where(eq(backtestExecutionIntents.id, intent.id));
        } else
          await tx.insert(backtestExecutionIntents).values({
            id: intent.id,
            runId: intent.runId,
            status: intent.status,
            dueAt: intent.dueAt,
            payload: intent,
          });
      });
    },
    async complete(result) {
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(backtestRuns)
          .where(eq(backtestRuns.id, result.plan.runId))
          .for('update');
        const existing = (
          await tx
            .select()
            .from(backtestResults)
            .where(eq(backtestResults.runId, result.plan.runId))
        )[0];
        if (existing && stableHash(existing.payload) !== stableHash(result))
          throw new Error('Completed backtest result is immutable');
        if (!existing)
          await tx
            .insert(backtestResults)
            .values({ runId: result.plan.runId, payload: result });
        await tx
          .update(backtestRuns)
          .set({
            status: 'COMPLETED',
            completedAt: new Date().toISOString(),
            errorCode: null,
          })
          .where(eq(backtestRuns.id, result.plan.runId));
      });
    },
    async fail(runId, cancelled) {
      await db
        .update(backtestRuns)
        .set({
          status: cancelled ? 'CANCELLED' : 'FAILED',
          completedAt: new Date().toISOString(),
          errorCode: cancelled ? 'REPLAY_CANCELLED' : 'BACKTEST_FAILED',
        })
        .where(
          and(eq(backtestRuns.id, runId), eq(backtestRuns.status, 'RUNNING')),
        );
    },
    async result(runId) {
      const row = (
        await db
          .select()
          .from(backtestResults)
          .where(eq(backtestResults.runId, runId))
      )[0];
      if (!row) throw new Error('Completed backtest not found');
      return row.payload;
    },
    async *equitySeries(runId, batchSize) {
      let cursor = '';
      for (;;) {
        const rows = await db
          .select()
          .from(backtestEquitySnapshots)
          .where(
            and(
              eq(backtestEquitySnapshots.runId, runId),
              gt(
                backtestEquitySnapshots.timestamp,
                cursor || '0001-01-01T00:00:00Z',
              ),
            ),
          )
          .orderBy(asc(backtestEquitySnapshots.timestamp))
          .limit(batchSize);
        if (!rows.length) return;
        for (const row of rows) {
          cursor = row.timestamp;
          yield equitySnapshotSchema.parse(row.payload);
        }
      }
    },
    async *intents(runId, batchSize) {
      let cursor = '';
      for (;;) {
        const rows = await db
          .select()
          .from(backtestExecutionIntents)
          .where(
            and(
              eq(backtestExecutionIntents.runId, runId),
              gt(
                backtestExecutionIntents.id,
                cursor || '00000000-0000-0000-0000-000000000000',
              ),
            ),
          )
          .orderBy(asc(backtestExecutionIntents.id))
          .limit(batchSize);
        if (!rows.length) return;
        for (const row of rows) {
          cursor = row.id;
          yield executionIntentSchema.parse(row.payload);
        }
      }
    },
    async *ledger(portfolioId, batchSize) {
      let cursor = 0;
      for (;;) {
        const rows = await db
          .select()
          .from(portfolioBalanceEvents)
          .where(
            and(
              eq(portfolioBalanceEvents.portfolioId, portfolioId),
              gt(portfolioBalanceEvents.sequence, cursor),
            ),
          )
          .orderBy(asc(portfolioBalanceEvents.sequence))
          .limit(batchSize);
        if (!rows.length) return;
        for (const row of rows) {
          cursor = row.sequence;
          yield row;
        }
      }
    },
  };
}
