import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config as dotenv } from 'dotenv';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  migrateDatabase,
  createHistoryRepository,
  createBacktestRepository,
  createPaperRepository,
  createStrategyRepository,
  backtestDatasetEvents,
  backtestDatasets,
  backtestResults,
  backtestRuns,
  orders,
  trades,
  marketEvents,
  marketTradeObservations,
  tokenRiskAssessments,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import {
  historicalSortKey,
  historyIdentity,
  stableId,
  stableHash,
} from '@solemn/shared';
import type { HistoricalEvent } from '@solemn/shared';
import { createBacktestFixture } from '../src/backtesting/replayFixture.js';
import { createBacktestPlan } from '../src/backtesting/backtestConfig.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
} from '../src/backtesting/historicalDataProvider.js';
import { runBacktest } from '../src/backtesting/replayEngine.js';
import { generateBacktestReport } from '../src/backtesting/reportGenerator.js';
import { replayPaperTrading } from '../src/portfolio/paperReplay.js';
import { createPaperReplayFixture } from '../src/portfolio/replayFixture.js';
import { backtestConfig } from './backtestFixtures.js';
import { replayTime } from '../src/strategy/replayFixture.js';
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
  const rollback = new Error('ROLLBACK_BACKTEST');
  try {
    await database.db.transaction(async (tx) => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
describe('isolated persisted historical backtests', () => {
  it(
    'replays all six cases through shared strategy/accounting, exports reports and preserves worker/raw history',
    async () =>
      rolledBack(async (tx) => {
        const paper = createPaperRepository(tx),
          strategy = createStrategyRepository(tx);
        const worker = await replayPaperTrading(
          createPaperReplayFixture(backtestConfig),
          backtestConfig,
          strategy,
          paper,
        );
        const originalWorker = await paper.snapshot(worker.definition.id);
        const originalRaw = {
          events: await tx.select().from(marketEvents),
          trades: await tx.select().from(marketTradeObservations),
          risks: await tx.select().from(tokenRiskAssessments),
        };
        const source = createBacktestFixture(backtestConfig),
          history = createHistoryRepository(tx),
          dataset = await history.register(
            source.manifest,
            historyEvents(source.events),
            100,
            100000,
          );
        const plan = createBacktestPlan(
            { dataset: 'fixtures' },
            dataset,
            backtestConfig,
          ),
          backtests = createBacktestRepository(tx),
          provider = new PostgresHistoricalDataProvider(dataset, history),
          services = { paper, strategy, backtests };
        const result = await runBacktest(
          plan,
          provider,
          backtestConfig,
          services,
        );
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        expect(result.metrics.strategy.positionsOpened).toBe(3);
        expect(result.metrics.trading.closedPositions).toBe(2);
        expect(result.metrics.portfolio.endingMarkedEquityUsd).toBeNull();
        expect(
          (
            await tx
              .select()
              .from(backtestRuns)
              .where(eq(backtestRuns.id, plan.runId))
          )[0],
        ).toMatchObject({ status: 'COMPLETED', portfolioId: plan.portfolioId });
        expect(
          await tx
            .select({ n: count() })
            .from(backtestResults)
            .where(eq(backtestResults.runId, plan.runId)),
        ).toEqual([{ n: 1 }]);
        const orderRows = await tx
            .select()
            .from(orders)
            .where(eq(orders.portfolioId, plan.portfolioId)),
          fillRows = await tx
            .select()
            .from(trades)
            .where(eq(trades.portfolioId, plan.portfolioId));
        expect(
          orderRows.every((order) => order.executionMode === 'PAPER'),
        ).toBe(true);
        expect(fillRows).toHaveLength(result.metrics.trading.filledOrders);
        const reportRoot = await mkdtemp(
          '/private/tmp/solemn-backtest-integration-',
        );
        try {
          const directory = await generateBacktestReport(
              result,
              backtests,
              reportRoot,
            ),
            markdown = await readFile(join(directory, 'report.md'), 'utf8');
          expect(markdown).toContain('SYNTHETIC');
          expect(markdown).toContain('unavailable');
          expect(markdown).toContain('No-trade baseline');
          expect(
            await readFile(join(directory, 'equity.csv'), 'utf8'),
          ).toContain('UNCERTAIN');
          expect(
            await readFile(join(directory, 'orders-and-fills.csv'), 'utf8'),
          ).toContain('STOP_LOSS');
          expect(
            await readFile(join(directory, 'positions.csv'), 'utf8'),
          ).toContain('EXIT_BLOCKED');
          expect(
            await readFile(join(directory, 'execution-intents.csv'), 'utf8'),
          ).toContain('EXPIRED');
        } finally {
          await rm(reportRoot, { recursive: true, force: true });
        }
        const repeat = await runBacktest(
          plan,
          provider,
          backtestConfig,
          services,
        );
        expect(repeat).toEqual(result);
        const otherPlan = createBacktestPlan(
            {
              dataset: 'fixtures',
              runId: stableId(['independent-persisted-backtest']),
            },
            dataset,
            backtestConfig,
          ),
          other = await runBacktest(
            otherPlan,
            provider,
            backtestConfig,
            services,
          );
        expect(other.metrics).toEqual(result.metrics);
        expect(other.plan.portfolioId).not.toBe(plan.portfolioId);
        const normalizedCurve = async (runId: string) => {
          const points = [];
          for await (const point of backtests.equitySeries(runId, 10)) {
            const { id, runId: run, ...economic } = point;
            void id;
            void run;
            points.push(economic);
          }
          return points;
        };
        expect(await normalizedCurve(otherPlan.runId)).toEqual(
          await normalizedCurve(plan.runId),
        );
        const economics = (rows: typeof orderRows) =>
          [...rows]
            .sort(
              (a, b) =>
                a.createdAt.localeCompare(b.createdAt) ||
                a.tokenMint.localeCompare(b.tokenMint),
            )
            .map((order) => ({
              side: order.side,
              status: order.status,
              quantity: order.requestedQuantity,
              fees: order.actualFeesUsd,
              at: order.createdAt,
              price: order.paperDetails?.trades[0]?.executionPriceUsd,
            }));
        expect(
          economics(
            await tx
              .select()
              .from(orders)
              .where(eq(orders.portfolioId, otherPlan.portfolioId)),
          ),
        ).toEqual(economics(orderRows));
        expect(await paper.snapshot(worker.definition.id)).toEqual(
          originalWorker,
        );
        expect(await tx.select().from(marketEvents)).toEqual(
          originalRaw.events,
        );
        expect(await tx.select().from(marketTradeObservations)).toEqual(
          originalRaw.trades,
        );
        expect(await tx.select().from(tokenRiskAssessments)).toEqual(
          originalRaw.risks,
        );
      }),
    30000,
  );
  it(
    'keeps dataset versions immutable and streams thousands of observations in bounded pages',
    async () =>
      rolledBack(async (tx) => {
        const file = createBacktestFixture(backtestConfig, 'winner'),
          sample = file.events.find((event) => event.kind === 'TRADE')!;
        if (sample.kind !== 'TRADE') throw new Error('Missing sample trade');
        const manifest = {
          ...file.manifest,
          datasetId: 'large-paginated-history',
        };
        async function* large() {
          for (let i = 0; i < 5001; i++) {
            const timestamp = new Date(
                Date.parse(replayTime(0)) + i * 100 + 1000,
              ).toISOString(),
              receivedAt = new Date(Date.parse(timestamp) + 50).toISOString(),
              sourceEventId = `large:${i}`;
            const trade = {
              ...sample.data,
              id: stableId(['market-trade', sample.data.source, sourceEventId]),
              sourceEventId,
              timestamp,
              receivedAt,
              usdObservedAt: timestamp,
            };
            const event: HistoricalEvent = {
              ...sample,
              id: historyIdentity(
                'TRADE',
                trade.mint,
                sample.poolAddress,
                trade.id,
              ),
              eventAt: timestamp,
              availableAt: receivedAt,
              data: trade,
            };
            yield event;
            if (i === 10) yield structuredClone(event);
          }
        }
        const history = createHistoryRepository(tx),
          dataset = await history.register(manifest, large(), 73, 10000);
        expect(dataset.quality.totalEvents).toBe(5001);
        expect(dataset.quality.duplicateEvents).toBe(1);
        let seen = 0,
          prior = '';
        for await (const event of history.events(
          dataset.id,
          manifest.startTime,
          manifest.endTime,
          37,
        )) {
          const key = historicalSortKey(event);
          expect(key > prior).toBe(true);
          prior = key;
          seen++;
        }
        expect(seen).toBe(5001);
        expect(await history.register(manifest, large(), 100, 10000)).toEqual(
          dataset,
        );
        let code: unknown;
        try {
          await tx.transaction(async (nested) => {
            await nested
              .update(backtestDatasetEvents)
              .set({ payloadHash: 'tampered' })
              .where(eq(backtestDatasetEvents.datasetId, dataset.id));
          });
        } catch (error) {
          code = (error as { cause?: { code?: string } }).cause?.code;
        }
        expect(code).toBe('23514');
        code = undefined;
        try {
          await tx.transaction(async (nested) => {
            await nested
              .update(backtestDatasets)
              .set({ fingerprint: '0'.repeat(64) })
              .where(eq(backtestDatasets.id, dataset.id));
          });
        } catch (error) {
          code = (error as { cause?: { code?: string } }).cause?.code;
        }
        expect(code).toBe('23514');
        expect(stableHash((await history.load(dataset.id)).quality)).toBe(
          stableHash(dataset.quality),
        );
      }),
    30000,
  );
});
