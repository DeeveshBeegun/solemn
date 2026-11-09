import { createStressFixture } from '../src/backtesting/stressScenarios.js';
import { runLiveForward } from '../src/forward/liveProvider.js';
import type { TransportFactory } from '../src/scanner/pumpPortalClient.js';
import { creationAck, migrationAck } from './scannerFixtures.js';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { getAddressDecoder } from '@solana/kit';
import pino from 'pino';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  assertSafeTestDatabase,
  createDatabase,
  createPaperRepository,
  executionSimulationAttempts,
  forwardAccounts,
  forwardRuntimeEvents,
  migrateDatabase,
  orders,
  operationalAuditEvents,
  operationalIncidents,
  trades,
  tokens,
  tokenRiskAssessments,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableHash, stableId, toAtomic } from '@solemn/shared';
import {
  forwardPortfolioId,
  initializeForwardAccount,
} from '../src/forward/account.js';
import { initialReplayCheckpoint } from '../src/forward/checkpoint.js';
import {
  changeForwardControl,
  forwardPerformance,
  forwardStatus,
} from '../src/forward/monitor.js';
import { createReplayProvider } from '../src/forward/replayProvider.js';
import { runForwardReplay } from '../src/forward/replayCoordinator.js';
import { reconcileForwardLedger } from '../src/operations/portfolioReconciler.js';
import { applyPaperCommand } from '../src/portfolio/portfolioManager.js';
import type { PaperCommand } from '@solemn/shared';
import { paperConfig } from './paperFixtures.js';
import { releaseTape } from './releaseFixture.js';

dotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const db = createDatabase(
  assertSafeTestDatabase(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  ),
);
const logger = pino({ level: 'silent' });
const config = {
  ...paperConfig,
  FORWARD_PAPER_ENABLED: true,
  FORWARD_ACCOUNT: 'week8-e2e',
};
beforeAll(() => migrateDatabase(db.db));
afterAll(() => db.close());
async function rollback(
  action: (tx: Database) => Promise<void>,
  id: string | null = forwardPortfolioId(config),
) {
  const lease = id ? await db.acquireForwardOwnership(id) : null;
  const sentinel = new Error('ROLL_BACK_FORWARD_TEST');
  try {
    await (lease?.db ?? db.db).transaction(async (tx) => {
      await action(tx);
      throw sentinel;
    });
  } catch (error) {
    if (error !== sentinel) throw error;
  } finally {
    lease?.release();
  }
}

it('locks one forward owner across PostgreSQL connections and releases ownership on close', async () => {
  const id = forwardPortfolioId(config),
    lease = await db.acquireForwardOwnership(id);
  try {
    await expect(db.acquireForwardOwnership(id)).rejects.toThrow(
      'Another forward worker',
    );
  } finally {
    lease.release();
  }
  const restarted = await db.acquireForwardOwnership(id);
  restarted.release();
});

it('fences a disconnected PostgreSQL owner and permits a new dedicated session', async () => {
  const id = forwardPortfolioId({
    ...config,
    FORWARD_ACCOUNT: 'week12-disconnect',
  });
  const lease = await db.acquireForwardOwnership(id);
  try {
    const backend = await lease.db.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`,
    );
    const terminated = await db.pool.query<{ stopped: boolean }>(
      'select pg_terminate_backend($1) as stopped',
      [backend.rows[0]!.pid],
    );
    expect(terminated.rows[0]?.stopped).toBe(true);
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    await expect(lease.db.execute(sql`select 1`)).rejects.toThrow();
    const replacement = await db.acquireForwardOwnership(id);
    try {
      expect((await replacement.db.execute(sql`select 1`)).rows).toHaveLength(
        1,
      );
    } finally {
      replacement.release();
    }
  } finally {
    lease.release();
  }
});

it('latches an interrupted recorded owner on the next startup', async () =>
  rollback(async (tx) => {
    const tape = createReplayProvider(config);
    const source = { fingerprint: tape.fingerprint, start: tape.startTime };
    const initial = initialReplayCheckpoint();
    const started = await initializeForwardAccount(tx, config, source, initial);
    expect(started.account.status).toBe('RECOVERING');
    const restored = await initializeForwardAccount(
      tx,
      config,
      source,
      initial,
    );
    expect(restored.account).toMatchObject({
      status: 'HALTED',
      opsReason: 'UNCLEAN_FORWARD_SHUTDOWN',
    });
    expect(restored.account.sessionId).not.toBe(started.account.sessionId);
  }));

it('halts a corrupt pending exit without changing the financial ledger', async () =>
  rollback(async (tx) => {
    const tape = createReplayProvider(config),
      stop = new AbortController();
    stop.abort();
    await runForwardReplay(tx, config, tape, logger, stop.signal);
    const id = forwardPortfolioId(config),
      paper = createPaperRepository(tx);
    const ledger = await paper.snapshot(id);
    await tx
      .update(forwardAccounts)
      .set({
        checkpoint: {
          ...initialReplayCheckpoint(),
          pending: [
            {
              kind: 'EXIT',
              id: stableId(['bad-exit']),
              positionId: stableId(['missing-position']),
              triggerAt: tape.startTime,
              expiresAt: '2026-01-01T00:01:00.000Z',
              reason: 'FAULT_INJECTION',
              quantity: '1',
              quote: null,
            },
          ],
        },
      })
      .where(eq(forwardAccounts.portfolioId, id));
    await expect(reconcileForwardLedger(tx, id)).rejects.toThrow(
      'Pending exit quantity',
    );
    await expect(runForwardReplay(tx, config, tape, logger)).rejects.toThrow(
      'Pending exit quantity',
    );
    expect(await forwardStatus(tx, config)).toMatchObject({
      status: 'HALTED',
      operationalReason: 'FORWARD_LEDGER_RECONCILIATION_FAILED',
    });
    expect(stableHash(await paper.snapshot(id))).toBe(stableHash(ledger));
  }));

it(
  'validates discovery through risk, paper fills, incident recovery and independent deterministic replay',
  async () =>
    rollback(async (tx) => {
      const { provider: tape, assessments } = await releaseTape(
          tx,
          config,
          logger,
        ),
        id = forwardPortfolioId(config),
        paper = createPaperRepository(tx),
        stop = new AbortController();
      let sawGap = false;
      const interrupted = await runForwardReplay(
        tx,
        config,
        tape,
        logger,
        stop.signal,
        async (frame) => {
          if (frame.at === '2026-01-01T00:16:03.010Z') {
            const { state } = await paper.load(id);
            expect(state.positions[0]).toMatchObject({
              status: 'OPEN',
              target1Complete: true,
              target2Complete: false,
            });
            expect(toAtomic(state.positions[0]!.quantity)).toBeLessThan(
              toAtomic(state.positions[0]!.originalQuantity),
            );
            await changeForwardControl(tx, config, 'pause');
          }
          if (frame.gap && !frame.connected) {
            sawGap = true;
            expect(await forwardStatus(tx, config)).toMatchObject({
              status: 'PAUSED',
              feedHealth: 'DISCONNECTED',
              openPositions: 1,
              markedEquityUsd: null,
            });
            expect((await paper.load(id)).state.positions[0]).toMatchObject({
              valuationStale: true,
              liquidationUncertain: true,
            });
            // A journal failure inside a savepoint rolls back the financial update completely.
            const beforeFailure = await paper.snapshot(id);
            const tick: PaperCommand = {
              type: 'TICK',
              at: frame.at,
              id: stableId(['week11-failed-tick', id]),
            };
            await expect(
              tx.transaction(async (nested) => {
                await nested.execute(
                  sql`create function pg_temp.week11_gap_fault() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_GAP_WRITE_FAILURE'; end; $$`,
                );
                await nested.execute(
                  sql`create trigger week11_gap_fault before insert on portfolio_balance_events for each row execute function pg_temp.week11_gap_fault()`,
                );
                await createPaperRepository(nested).transact(
                  id,
                  tick,
                  (state, definition) =>
                    applyPaperCommand(state, tick, definition),
                );
              }),
            ).rejects.toThrow();
            expect(stableHash(await paper.snapshot(id))).toBe(
              stableHash(beforeFailure),
            );
            await changeForwardControl(
              tx,
              config,
              'halt',
              'Incident exercise after failed ledger write',
            );
            expect(await forwardStatus(tx, config)).toMatchObject({
              status: 'HALTED',
              openPositions: 1,
              newEntries: false,
            });
          }
          if (frame.at === '2026-01-01T00:18:02.010Z') stop.abort();
        },
      );
      expect(sawGap).toBe(true);
      expect(interrupted.checkpoint).toMatchObject({
        signals: 1,
        gaps: 1,
        reconnections: 1,
        downtimeMs: 65000,
      });
      const before = (await paper.load(id)).state.positions[0]!;
      expect(before).toMatchObject({
        status: 'OPEN',
        target1Complete: true,
        target2Complete: true,
      });
      expect(toAtomic(before.trailingPeakUsd!)).toBeGreaterThan(
        toAtomic('390'),
      );
      const resumed = await runForwardReplay(tx, config, tape, logger);
      expect(resumed).toMatchObject({
        portfolioId: id,
        startingBalanceUsd: '100',
        availableCashUsd: '101.098514',
        markedEquityUsd: '101.098514',
        realizedNetPnlUsd: '1.098514',
        unrealizedPnlUsd: '0',
      });
      const result = await paper.snapshot(id);
      const entry = result.events.find(
        (event) => event.command?.type === 'ENTRY',
      )?.command;
      expect(entry?.type).toBe('ENTRY');
      if (entry?.type !== 'ENTRY')
        throw new Error('Missing release fixture entry');
      expect(assessments.has(entry.candidate.riskAssessmentId)).toBe(true);
      expect(entry.risk?.assessment?.id).toBe(entry.candidate.riskAssessmentId);
      const repeatedConfig = {
        ...config,
        FORWARD_ACCOUNT: 'week12-determinism',
      };
      const repeatedId = forwardPortfolioId(repeatedConfig);
      // Same test session owns both scopes. No separate writer is permitted.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${repeatedId}, 8))`,
      );
      await runForwardReplay(tx, repeatedConfig, tape, logger);
      const independent = await paper.snapshot(repeatedId);
      const economics = (snapshot: typeof result) => {
        const {
          availableCashUsd,
          reservedCashUsd,
          equityUsd,
          realizedPnlUsd,
          unrealizedPnlUsd,
          investedCostBasisUsd,
          buyFeesUsd,
          sellFeesUsd,
          positions,
        } = snapshot.state;
        return {
          availableCashUsd,
          reservedCashUsd,
          equityUsd,
          realizedPnlUsd,
          unrealizedPnlUsd,
          investedCostBasisUsd,
          buyFeesUsd,
          sellFeesUsd,
          positions: positions.map(
            ({ status, quantity, costBasisUsd, trailingPeakUsd }) => ({
              status,
              quantity,
              costBasisUsd,
              trailingPeakUsd,
            }),
          ),
          fills: snapshot.events.flatMap((event) =>
            event.orders.flatMap((order) =>
              order.trades.map(
                ({ executedQuantity, executionPriceUsd, feesUsd }) => ({
                  executedQuantity,
                  executionPriceUsd,
                  feesUsd,
                }),
              ),
            ),
          ),
        };
      };
      expect(economics(independent)).toEqual(economics(result));
      expect(await reconcileForwardLedger(tx, id)).toMatchObject({
        orders: 4,
        fills: 4,
        state: { availableCashUsd: '101.098514', realizedPnlUsd: '1.098514' },
      });
      const activeIncidents = await tx
        .select()
        .from(operationalIncidents)
        .where(eq(operationalIncidents.portfolioId, id));
      expect(activeIncidents.map((incident) => incident.category)).toEqual(
        expect.arrayContaining(['ADMINISTRATIVE_HALT', 'MARKET_DATA_OUTAGE']),
      );
      expect(await forwardStatus(tx, config)).toMatchObject({
        status: 'HALTED',
        newEntries: false,
      });
      expect(result.state.positions[0]).toMatchObject({
        status: 'CLOSED',
        quantity: '0',
        costBasisUsd: '0',
        target1Complete: true,
        target2Complete: true,
        trailingPeakUsd: before.trailingPeakUsd,
      });
      const fills = await tx
        .select()
        .from(trades)
        .where(eq(trades.portfolioId, id));
      expect(fills).toHaveLength(4);
      const attempts = await tx
        .select()
        .from(executionSimulationAttempts)
        .where(eq(executionSimulationAttempts.forwardPortfolioId, id));
      expect(attempts).toHaveLength(4);
      expect(
        attempts.every(
          (a) =>
            a.runId === null &&
            a.outcome === 'FILLED' &&
            a.payload.context.quote.dueAt <= a.payload.executedAt,
        ),
      ).toBe(true);
      const events = await tx
        .select()
        .from(forwardRuntimeEvents)
        .where(eq(forwardRuntimeEvents.portfolioId, id));
      expect(events.filter((e) => e.kind === 'GAP_STARTED')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'GAP_ENDED')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'SESSION_STARTED')).toHaveLength(
        2,
      );
      await runForwardReplay(tx, config, tape, logger);
      const repeated = await paper.snapshot(id);
      expect(stableHash(repeated)).toBe(stableHash(result));
      expect(await forwardPerformance(tx, config)).toMatchObject({
        metrics: {
          strategy: {
            signalsGenerated: 1,
            takeProfitExits: 2,
            trailingStopExits: 1,
          },
          trading: { filledOrders: 4, closedPositions: 1 },
        },
      });
      await changeForwardControl(tx, config, 'halt', 'Emergency drill');
      await expect(changeForwardControl(tx, config, 'resume')).rejects.toThrow(
        'HALTED',
      );
      await expect(
        changeForwardControl(
          tx,
          config,
          'reset-halt',
          'Emergency drill verified',
        ),
      ).rejects.toThrow('active owner');
      expect(await forwardStatus(tx, config)).toMatchObject({
        paused: false,
        riskStatus: 'ACTIVE',
        status: 'HALTED',
      });
    }),
  120000,
);

it(
  'enforces the final entry gate and authorizes resume and halt reset only with an owned healthy session',
  async () =>
    rollback(async (tx) => {
      const tape = createReplayProvider(config),
        stop = new AbortController();
      const id = forwardPortfolioId(config),
        paper = createPaperRepository(tx);
      let tested = false;
      await runForwardReplay(
        tx,
        config,
        tape,
        logger,
        stop.signal,
        async (frame) => {
          if (
            frame.at < '2026-01-01T00:14:06.010Z' ||
            frame.at > '2026-01-01T00:15:00.000Z' ||
            tested
          )
            return;
          const account = (
            await tx
              .select()
              .from(forwardAccounts)
              .where(eq(forwardAccounts.portfolioId, id))
          )[0];
          if (
            account?.status !== 'RUNNING' ||
            account.health?.protectiveExits !== true
          )
            return;
          const before = await paper.snapshot(id);
          const entry = before.events.find(
            (event) => event.command?.type === 'ENTRY',
          )?.command;
          if (
            !entry ||
            entry.type !== 'ENTRY' ||
            !before.state.positions.length
          )
            return;
          tested = true;
          await expect(
            changeForwardControl(tx, config, 'resume'),
          ).rejects.toThrow('invalid');
          await changeForwardControl(tx, config, 'pause');
          const bypass = {
            ...entry,
            id: stableId(['week11-entry-bypass', id]),
            at: frame.at,
          };
          await expect(
            paper.transact(id, bypass, () => {
              throw new Error('Reducer should not run');
            }),
          ).rejects.toThrow('Operational entry gate is closed');
          expect(stableHash(await paper.snapshot(id))).toBe(stableHash(before));
          expect(
            await changeForwardControl(tx, config, 'resume'),
          ).toMatchObject({ state: 'RECOVERING' });
          const first = await changeForwardControl(
            tx,
            config,
            'halt',
            'Operator drill',
          );
          expect(
            await changeForwardControl(tx, config, 'halt', 'Operator drill'),
          ).toEqual(first);
          await expect(
            changeForwardControl(tx, config, 'resume'),
          ).rejects.toThrow('HALTED');
          expect(
            await changeForwardControl(
              tx,
              config,
              'reset-halt',
              'Ledger and market verified',
            ),
          ).toMatchObject({
            state: 'RECOVERING',
            reason: 'HALT_RESET_APPROVED',
          });
          const audit = await tx
            .select()
            .from(operationalAuditEvents)
            .where(eq(operationalAuditEvents.portfolioId, id));
          expect(
            audit.filter((event) => event.kind === 'EMERGENCY_HALT'),
          ).toHaveLength(1);
          expect(
            audit.filter((event) => event.kind === 'HALT_RESET_REQUESTED'),
          ).toHaveLength(1);
          await expect(
            tx.transaction((savepoint) =>
              savepoint
                .delete(operationalAuditEvents)
                .where(eq(operationalAuditEvents.id, audit[0]!.id)),
            ),
          ).rejects.toThrow();
          stop.abort();
        },
      );
      expect(tested).toBe(true);
    }),
  120000,
);

it(
  'rolls back an accepted execution frame and preserves the halt through restart',
  async () =>
    rollback(async (tx) => {
      const tape = createReplayProvider(config),
        id = forwardPortfolioId(config),
        paper = createPaperRepository(tx);
      await tx.execute(
        sql`create function pg_temp.forward_test_fault() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_FORWARD_PERSISTENCE_FAILURE'; end; $$`,
      );
      await tx.execute(
        sql`create trigger forward_test_fault before insert on forward_runtime_events for each row when (new.kind='PAPER_RESULT') execute function pg_temp.forward_test_fault()`,
      );
      await expect(
        runForwardReplay(tx, config, tape, logger),
      ).rejects.toThrow();
      expect((await paper.load(id)).state.availableCashUsd).toBe('100');
      expect(
        await tx.select().from(orders).where(eq(orders.portfolioId, id)),
      ).toHaveLength(0);
      expect(
        await tx
          .select()
          .from(executionSimulationAttempts)
          .where(eq(executionSimulationAttempts.forwardPortfolioId, id)),
      ).toHaveLength(0);
      const row = (
        await tx
          .select()
          .from(forwardAccounts)
          .where(eq(forwardAccounts.portfolioId, id))
      )[0]!;
      expect(row).toMatchObject({
        status: 'HALTED',
        checkpoint: { pending: [] },
      });
      await tx.execute(
        sql`drop trigger forward_test_fault on forward_runtime_events`,
      );
      const stop = new AbortController();
      await runForwardReplay(tx, config, tape, logger, stop.signal, (frame) => {
        if (frame.at >= '2026-01-01T00:14:08.000Z') stop.abort();
      });
      expect(
        await tx.select().from(orders).where(eq(orders.portfolioId, id)),
      ).toHaveLength(0);
      expect(
        await tx.select().from(trades).where(eq(trades.portfolioId, id)),
      ).toHaveLength(0);
      expect((await paper.load(id)).state.positions).toHaveLength(0);
    }),
  120000,
);

it(
  'cancels a signal awaiting execution when the feed disconnects before landing',
  async () =>
    rollback(async (tx) => {
      const tape = createReplayProvider(config, undefined, [
        {
          start: '2026-01-01T00:14:05.500Z',
          end: '2026-01-01T00:14:06.500Z',
          reason: 'BEFORE_LANDING',
        },
      ]);
      const stop = new AbortController();
      const result = await runForwardReplay(
        tx,
        config,
        tape,
        logger,
        stop.signal,
        (frame) => {
          if (frame.at >= '2026-01-01T00:14:10.000Z') stop.abort();
        },
      );
      expect(result).toMatchObject({
        availableCashUsd: '100',
        checkpoint: { signals: 1, gaps: 1, pending: [] },
      });
      expect(
        await tx
          .select()
          .from(orders)
          .where(eq(orders.portfolioId, result.portfolioId)),
      ).toHaveLength(0);
      const events = await tx
        .select()
        .from(forwardRuntimeEvents)
        .where(eq(forwardRuntimeEvents.portfolioId, result.portfolioId));
      expect(
        events.find((e) => e.kind === 'INTENT_SETTLED')?.details,
      ).toMatchObject({ status: 'CANCELLED', reasons: ['FEED_DISCONNECTED'] });
    }),
  120000,
);

it(
  'collects metered evidence on a mock discovery socket and preserves the billing latch after restart',
  async () =>
    rollback(
      async (owned) =>
        rollback(async (operational) => {
          const live = {
            ...config,
            FORWARD_MARKET_DATA_MODE: 'LIVE_READ_ONLY' as const,
            ENABLE_METERED_MARKET_DATA: true,
            PUMPPORTAL_API_KEY: 'offline-mock-key',
            FORWARD_DAILY_EVENT_BUDGET: 2,
          };
          const file = createStressFixture(config),
            eligible = file.events.find(
              (e) => e.kind === 'RISK' && e.data.currentStatus === 'ELIGIBLE',
            );
          if (eligible?.kind !== 'RISK' || !eligible.data.assessment)
            throw new Error('Fixture has no risk evidence');
          const base = eligible.data.assessment,
            mint = getAddressDecoder().decode(new Uint8Array(32).fill(182)),
            assessmentId = stableId(['metered-mock-assessment', mint]),
            requestId = stableId(['metered-mock-request', mint]),
            now = new Date().toISOString(),
            until = new Date(Date.now() + 120000).toISOString();
          await operational.insert(tokens).values({
            mintAddress: mint,
            sourcePlatform: 'MOCK_PUMPPORTAL',
            discoveredAt: now,
          });
          await operational.insert(tokenRiskAssessments).values({
            ...base,
            id: assessmentId,
            tokenMint: mint,
            requestId,
            evidence: {
              ...base.evidence,
              jupiter: { ...base.evidence.jupiter, mint },
              solana: { ...base.evidence.solana, mint },
            },
            requestedAt: now,
            assessedAt: now,
            validUntil: until,
            policyVersion: base.policy.version,
          });
          await operational
            .update(tokens)
            .set({
              riskStatus: 'ELIGIBLE',
              riskRequestId: requestId,
              riskValidUntil: until,
              latestRiskAssessmentId: assessmentId,
            })
            .where(eq(tokens.mintAddress, mint));
          const sent: string[] = [],
            credentials: boolean[] = [];
          const factory =
            (stop: AbortController, expectTrades: boolean): TransportFactory =>
            (url, handlers) => {
              credentials.push(new URL(url).searchParams.has('api-key'));
              queueMicrotask(() => handlers.open());
              return {
                send(raw) {
                  const { method } = JSON.parse(raw) as { method: string };
                  sent.push(method);
                  if (method === 'subscribeNewToken')
                    queueMicrotask(() => handlers.message(creationAck, false));
                  if (method === 'subscribeMigration')
                    queueMicrotask(() => {
                      handlers.message(migrationAck, false);
                      if (!expectTrades) stop.abort();
                    });
                  if (method === 'subscribeTokenTrade')
                    queueMicrotask(() => {
                      const evidence = JSON.stringify({
                        txType: 'buy',
                        mint,
                        tokenAmount: '123.456',
                        solAmount: '0.001',
                      });
                      handlers.message(evidence, false);
                      handlers.message(evidence, false);
                    });
                },
                ping() {},
                close() {
                  handlers.close(1000);
                },
                terminate() {
                  handlers.close(1006);
                  stop.abort();
                },
              };
            };
          const stop = new AbortController();
          const first = await runLiveForward(
            owned,
            operational,
            live,
            logger,
            AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
            factory(stop, true),
          );
          expect(first).toMatchObject({
            readiness: 'NOT_READY',
            checkpoint: {
              budget: { events: 2, blocked: true, armed: false },
              lastTradeAt: null,
            },
          });
          const restart = new AbortController();
          const again = await runLiveForward(
            owned,
            operational,
            live,
            logger,
            AbortSignal.any([restart.signal, AbortSignal.timeout(5000)]),
            factory(restart, false),
          );
          expect(again.checkpoint.budget).toEqual(first.checkpoint.budget);
          expect(credentials).toEqual([true, false]);
          expect(
            sent.filter((method) => method === 'subscribeTokenTrade'),
          ).toHaveLength(1);
          const observed = await owned
            .select()
            .from(forwardRuntimeEvents)
            .where(eq(forwardRuntimeEvents.portfolioId, first.portfolioId));
          expect(
            observed.filter((e) => e.kind === 'LIVE_TRADE_EVIDENCE'),
          ).toHaveLength(1);
          expect(
            observed.some(
              (e) =>
                e.kind === 'GAP_STARTED' &&
                e.details.reason === 'METERED_BUDGET_EXHAUSTED',
            ),
          ).toBe(true);
          expect(
            await owned
              .select()
              .from(orders)
              .where(eq(orders.portfolioId, first.portfolioId)),
          ).toHaveLength(0);
          expect(await forwardStatus(owned, live)).toMatchObject({
            availableCashUsd: '100',
            liveReadiness: 'NOT_READY',
            status: 'STOPPED',
          });
        }, null),
      forwardPortfolioId({
        ...config,
        FORWARD_MARKET_DATA_MODE: 'LIVE_READ_ONLY',
      }),
    ),
  30000,
);
