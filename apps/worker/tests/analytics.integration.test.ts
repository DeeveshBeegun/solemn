import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config as dotenv } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createBacktestRepository,
  createDatabase,
  createHistoryRepository,
  createPaperRepository,
  createStrategyRepository,
  migrateDatabase,
  strategyEvaluations,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableHash, toAtomic } from '@solemn/shared';
import { createAnalyticsFixture } from '../src/backtesting/analyticsFixture.js';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
} from '../src/backtesting/historicalDataProvider.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { executionScenario } from '../src/execution/simulation/executionScenarios.js';
import { readEvaluation } from '../src/analytics/readEvaluation.js';
import { evaluateStrategy } from '../src/analytics/strategyEvaluator.js';
import { generateAnalyticsReport } from '../src/analytics/reportGenerator.js';
import {
  registerPeriod,
  saveEvaluation,
} from '../src/analytics/evaluationRepository.js';
import type { EvaluationBody } from '../src/analytics/evaluationRepository.js';
import { compareEvaluations } from '../src/analytics/performanceComparison.js';
import {
  forwardPortfolioId,
  initializeForwardAccount,
} from '../src/forward/account.js';
import { initialReplayCheckpoint } from '../src/forward/checkpoint.js';
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
const strategyId = 'SOLEMN_LAUNCH_MOMENTUM_V1';
beforeAll(() => migrateDatabase(database.db));
afterAll(() => database.close());
async function rolledBack(test: (tx: Database) => Promise<void>) {
  const rollback = new Error('ROLLBACK_ANALYTICS');
  try {
    await database.db.transaction(async (tx) => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

it(
  'reconciles a full persisted fixture, attributes every outcome and publishes identical reports on repeat',
  async () =>
    rolledBack(async (tx) => {
      const file = createAnalyticsFixture(backtestConfig),
        history = createHistoryRepository(tx);
      const dataset = await history.register(
        file.manifest,
        historyEvents(file.events),
        1000,
        1000000,
      );
      const plan = createBacktestPlan(
        {
          dataset: 'fixtures-analytics',
          execution: executionScenario('baseline'),
        },
        dataset,
        backtestConfig,
      );
      const paper = createPaperRepository(tx),
        backtests = createBacktestRepository(tx);
      const result = await runBacktest(
        plan,
        new PostgresHistoricalDataProvider(dataset, history),
        backtestConfig,
        { paper, backtests, strategy: createStrategyRepository(tx) },
      );
      const before = await paper.snapshot(plan.portfolioId);
      const selection = {
        strategyId,
        portfolioId: plan.portfolioId,
        source: 'synthetic' as const,
      };
      const capture = await readEvaluation(tx, selection);
      const evaluation = evaluateStrategy(capture!);
      expect(evaluation).toMatchObject({
        status: 'INSUFFICIENT_DATA',
        portfolio: {
          initialBankrollUsd: '100',
          endingCashUsd: '107.509396',
          endingMarkedEquityUsd: null,
          netReturnPercent: null,
          realizedNetPnlUsd: result.finalState.realizedPnlUsd,
          unpricedPositions: 1,
          missingScheduledSnapshots: 0,
        },
        trading: {
          closedPositions: 6,
          winningClosedPositions: 3,
          losingClosedPositions: 3,
          openPositions: 1,
          blockedExits: 1,
          filledOrders: 21,
          failedOrders: 5,
          winRatePercent: '50',
          closedNetPnlUsd: '7.032008',
        },
        costs: { bookedFeesUsd: '0.080865444', complete: true },
        signalFunnel: {
          buyCandidates: 8,
          filledEntries: 7,
          closedPositions: 6,
          outcomes: {
            CLOSED_WIN: 3,
            CLOSED_LOSS: 3,
            ENTRY_FAILED: 1,
            EXIT_BLOCKED: 1,
          },
        },
        statistics: {
          withoutLargestWinner: {
            remainingClosedNetPnlUsd: '-0.372274',
            signChanged: true,
          },
        },
      });
      expect(
        toAtomic(evaluation.costs.knownFailedTransactionFeesUsd),
      ).toBeGreaterThan(0n);
      expect(
        evaluation.rows.trades.some(
          (t) => t.exitFills === 3 && t.status === 'CLOSED',
        ),
      ).toBe(true);
      expect(
        evaluation.rows.segments.some(
          (s) =>
            s.dimension === 'volumeAcceleration' && s.completedPositions > 0,
        ),
      ).toBe(true);
      expect(evaluation.trading.profitFactor.value).toBe(
        result.metrics.trading.profitFactor.value,
      );
      expect(evaluation.portfolio.maximumObservedDrawdownPercent).toBe(
        result.metrics.portfolio.maximumDrawdownPercent,
      );
      const early = await readEvaluation(tx, {
        ...selection,
        end: '2026-01-01T00:14:06.000Z',
      });
      expect(evaluateStrategy(early!)).toMatchObject({
        trading: { closedPositions: 0, openPositions: 1 },
        signalFunnel: { buyCandidates: 1, outcomes: { POSITION_OPEN: 1 } },
        portfolio: { endingMarkedEquityUsd: null },
      });
      expect(
        await readEvaluation(tx, { strategyId, source: 'forward' }),
      ).toBeNull();
      await expect(
        readEvaluation(tx, { ...selection, source: 'forward' }),
      ).rejects.toThrow('does not match');
      const comparison = compareEvaluations(evaluation, null);
      expect(comparison.status).toBe('NON_COMPARABLE');
      const body: EvaluationBody = {
        source: 'synthetic',
        strategyId,
        requestedStart: capture!.start,
        requestedEnd: capture!.end,
        status: evaluation.status,
        reason: null,
        evaluation,
        comparison,
        inputFingerprint: capture!.inputFingerprint,
      };
      const saved = await saveEvaluation(tx, body);
      const root = await mkdtemp(join(tmpdir(), 'solemn-week9-report-'));
      try {
        const directory = await generateAnalyticsReport(saved, root);
        const names = [
          'summary.md',
          'metrics.json',
          'data-quality.json',
          'trades.csv',
          'signals.csv',
          'segments.csv',
          'equity.csv',
        ];
        const first = await Promise.all(
          names.map((name) => readFile(join(directory, name), 'utf8')),
        );
        const again = await readEvaluation(tx, selection);
        expect(again?.inputFingerprint).toBe(capture?.inputFingerprint);
        const repeated = await saveEvaluation(tx, {
          ...body,
          evaluation: evaluateStrategy(again!),
        });
        expect(repeated).toEqual(saved);
        expect(await generateAnalyticsReport(repeated, root)).toBe(directory);
        expect(
          await Promise.all(
            names.map((name) => readFile(join(directory, name), 'utf8')),
          ),
        ).toEqual(first);
        expect(
          JSON.parse(first[1]!).evaluation.statistics.withoutLargestWinner
            .remainingClosedNetPnlUsd,
        ).toBe('-0.372274');
        expect(first[4]).toContain('ENTRY_FAILED');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      await expect(
        tx.transaction(async (nested) => {
          await nested
            .update(strategyEvaluations)
            .set({ status: 'UNDERPERFORMING' })
            .where(eq(strategyEvaluations.id, saved.id));
        }),
      ).rejects.toThrow();
      expect(stableHash(await paper.snapshot(plan.portfolioId))).toBe(
        stableHash(before),
      );
      expect(stableHash(await backtests.result(plan.runId))).toBe(
        stableHash(result),
      );
      await tx.execute(sql`set constraints all immediate`);
    }),
  120000,
);

it('binds future periods to a frozen source and rejects inspected, overlapping or mislabeled holdouts', async () =>
  rolledBack(async (tx) => {
    const now = new Date().toISOString(),
      config = {
        ...backtestConfig,
        FORWARD_MARKET_DATA_MODE: 'LIVE_READ_ONLY' as const,
        FORWARD_PAPER_ENABLED: true,
      };
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${forwardPortfolioId(config)}, 8))`,
    );
    const { account } = await initializeForwardAccount(
      tx,
      config,
      { fingerprint: 'PUMPPORTAL_EVIDENCE_V1', start: now },
      {},
    );
    const selection = {
      strategyId,
      portfolioId: account.portfolioId,
      source: 'forward' as const,
      type: 'HOLDOUT' as const,
      start: new Date(Date.now() + 86400000).toISOString(),
      end: new Date(Date.now() + 172800000).toISOString(),
    };
    const registered = await registerPeriod(tx, selection);
    expect(await registerPeriod(tx, selection)).toEqual(registered);
    await expect(
      registerPeriod(tx, { ...selection, type: 'VALIDATION' }),
    ).rejects.toThrow('isolated registration');
    await expect(
      registerPeriod(tx, { ...selection, start: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toThrow('future interval');
    await expect(
      readEvaluation(tx, { strategyId, periodId: registered.id }),
    ).rejects.toThrow('stored source range');
    const replayConfig = {
      ...config,
      FORWARD_MARKET_DATA_MODE: 'REPLAY' as const,
      FORWARD_ACCOUNT: 'week9-isolation',
    };
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${forwardPortfolioId(replayConfig)}, 8))`,
    );
    const replay = await initializeForwardAccount(
      tx,
      replayConfig,
      { fingerprint: 'isolated-replay', start: '2026-01-01T00:00:00.000Z' },
      initialReplayCheckpoint(),
    );
    await expect(
      registerPeriod(tx, {
        ...selection,
        source: 'forward-replay',
        portfolioId: replay.account.portfolioId,
      }),
    ).rejects.toThrow('live forward portfolio');
    const observed = await readEvaluation(tx, {
      strategyId,
      source: 'forward-replay',
      portfolioId: replay.account.portfolioId,
    });
    expect(observed?.source).toBe('forward-replay');
    expect(observed?.portfolioId).not.toBe(account.portfolioId);
  }));
