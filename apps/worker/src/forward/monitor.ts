import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  createBacktestRepository,
  createPaperRepository,
  forwardAccounts,
  forwardOwnerPid,
  forwardRuntimeEvents,
  strategyDecisions,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import {
  fromAtomic,
  idSchema,
  strategyDecisionSchema,
  toAtomic,
} from '@solemn/shared';
import type { BacktestMetrics } from '@solemn/shared';
import { PerformanceAnalyzer } from '../backtesting/performanceAnalyzer.js';
import type { Config } from '../config/index.js';
import { changeOperationalControl } from '../operations/adminControls.js';
import type { AdministrativeAction } from '../operations/adminControls.js';
import {
  equityDetails,
  forwardPortfolioId,
  lockForwardAccount,
  recordForwardEvent,
} from './account.js';
import { replayCheckpointSchema } from './checkpoint.js';
import { readLiveCheckpoint } from './liveProvider.js';
import { operationalMetrics } from '../monitoring/metrics.js';
import { newBudget } from './meteredFeed.js';

export async function forwardStatus(db: Database, config: Config) {
  const id = forwardPortfolioId(config);
  return db.transaction(
    async (tx) => {
      const account = (
        await tx
          .select()
          .from(forwardAccounts)
          .where(eq(forwardAccounts.portfolioId, id))
      )[0];
      if (!account)
        return {
          portfolioId: id,
          status: 'NOT_INITIALIZED',
          mode: config.FORWARD_MARKET_DATA_MODE,
        };
      const { definition, state } = await createPaperRepository(tx).load(id);
      const health =
        account.mode === 'REPLAY'
          ? replayCheckpointSchema.parse(account.checkpoint)
          : readLiveCheckpoint(account.checkpoint);
      const ended = (
        await tx
          .select({ at: forwardRuntimeEvents.at })
          .from(forwardRuntimeEvents)
          .where(
            and(
              eq(forwardRuntimeEvents.portfolioId, id),
              eq(forwardRuntimeEvents.sessionId, account.sessionId),
              eq(forwardRuntimeEvents.kind, 'SESSION_ENDED'),
            ),
          )
          .limit(1)
      )[0];
      const owned =
        account.ownerPid !== null &&
        (await forwardOwnerPid(tx, id, account.ownerPid)) === account.ownerPid;
      const active =
        owned &&
        !ended &&
        account.status !== 'STOPPED' &&
        Date.now() - Date.parse(account.heartbeatAt) < 30000;
      const open = state.positions.filter((p) => p.status !== 'CLOSED');
      return {
        portfolioId: id,
        sessionId: account.sessionId,
        status: account.status,
        operationalReason: account.opsReason,
        operationalVersion: account.opsVersion,
        operationalActor: account.opsActor,
        operationalUpdatedAt: account.opsUpdatedAt,
        operationalHealth: account.health,
        ownershipVerified: owned,
        newEntries:
          active &&
          account.status === 'RUNNING' &&
          account.health?.market === 'HEALTHY' &&
          Date.now() - Date.parse(account.health.checkedAt) <
            config.OPERATIONS_HEALTH_CHECK_INTERVAL_SECONDS * 2000,
        protectiveExits:
          active &&
          account.health?.protectiveExits === true &&
          Date.now() - Date.parse(account.health.checkedAt) <
            config.OPERATIONS_HEALTH_CHECK_INTERVAL_SECONDS * 2000,
        workerHeartbeatFresh: active,
        uptimeSeconds:
          ended || active
            ? Math.max(
                0,
                Math.floor(
                  ((ended ? Date.parse(ended.at) : Date.now()) -
                    Date.parse(account.startedAt)) /
                    1000,
                ),
              )
            : null,
        endedAt: ended?.at ?? null,
        startedAt: account.startedAt,
        heartbeatAt: account.heartbeatAt,
        tradingMode: definition.mode,
        provider: account.mode === 'REPLAY' ? 'SYNTHETIC_REPLAY' : 'PUMPPORTAL',
        liveReadiness: 'NOT_READY',
        paused: account.paused,
        riskStatus: state.status,
        haltReason: state.haltReason,
        feedHealth: health.feedHealth,
        trackedTokens: health.tracked,
        openPositions: open.length,
        unresolvedPositions: open.filter(
          (p) =>
            p.valuationStale ||
            p.liquidationUncertain ||
            p.status === 'EXIT_BLOCKED',
        ).length,
        lastSignalAt: health.lastSignalAt,
        lastObservationAt: health.lastObservationAt,
        lastValidTradeAt: health.lastTradeAt,
        lastCompletedCandleAt: health.lastCandleAt,
        reconnections: health.reconnections,
        gaps: health.gaps,
        downtimeMs: health.downtimeMs,
        warnings: health.warnings,
        errors: health.errors,
        ...('budget' in health
          ? {
              meteredUsage: health.budget,
              lastProviderMessageAt: health.lastMessageAt,
              lastTradeEvidenceAt: health.lastTradeEvidenceAt,
              validationErrors: health.validationErrors,
              rateLimitEvents: health.rateLimitEvents,
              failedPersistenceWrites: health.failedPersistenceWrites,
              providerConnection: health.providerConnection,
              queueDepth: health.queueDepth,
              readinessReasons: health.reasons,
            }
          : { cursor: health.cursor, pendingIntents: health.pending.length }),
        activity: await operationalMetrics(tx, id, definition.strategyRunId),
        bookedPaperFees: {
          buyUsd: state.buyFeesUsd,
          sellUsd: state.sellFeesUsd,
        },
        ...equityDetails(state, definition),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function changeForwardControl(
  db: Database,
  config: Config,
  action: AdministrativeAction | 'rearm-metered',
  reason?: string,
) {
  if (action !== 'rearm-metered')
    return changeOperationalControl(db, config, action, reason);
  return db.transaction(async (tx) => {
    const id = forwardPortfolioId(config),
      row = await lockForwardAccount(tx, id);
    if (row.mode !== 'LIVE_READ_ONLY')
      throw new Error('Metered controls require live read-only mode');
    const at = new Date().toISOString(),
      checkpoint = readLiveCheckpoint(row.checkpoint);
    if (at.slice(0, 10) <= checkpoint.budget.day)
      throw new Error('Metered rearm requires a new UTC budget day');
    checkpoint.budget = newBudget(at);
    await tx
      .update(forwardAccounts)
      .set({ checkpoint })
      .where(eq(forwardAccounts.portfolioId, id));
    await recordForwardEvent(tx, row, 'ADMIN_CONTROL', at, at, { action });
    return { portfolioId: id, action, applied: true };
  });
}

function comparable(metrics: BacktestMetrics, periodMs: number) {
  const attempts = metrics.trading.filledOrders + metrics.trading.failedOrders;
  const fees = metrics.portfolio.totalFeesUsd;
  return {
    signals: metrics.strategy.signalsGenerated,
    signalsPerHour:
      periodMs > 0
        ? fromAtomic(
            (BigInt(metrics.strategy.signalsGenerated) *
              3600000n *
              10n ** 18n) /
              BigInt(periodMs),
          )
        : null,
    averageFeesPerOrderUsd:
      attempts && fees !== null
        ? fromAtomic(toAtomic(fees) / BigInt(attempts))
        : null,
    entryFillRatePercent: metrics.execution?.entryFillRatePercent ?? null,
    exitFillRatePercent: metrics.execution?.exitFillRatePercent ?? null,
    netReturnPercent: metrics.portfolio.totalNetReturnPercent,
    maximumReliableSnapshotDrawdownPercent:
      metrics.portfolio.maximumDrawdownPercent,
    drawdownCoverageComplete: metrics.portfolio.drawdownCoverageComplete,
    closedPositions: metrics.trading.closedPositions,
    sample:
      metrics.trading.closedPositions < 30
        ? 'INSUFFICIENT_SAMPLE'
        : 'DESCRIPTIVE_SAMPLE',
    dataQuality: metrics.dataQuality,
  };
}
export async function forwardPerformance(
  db: Database,
  config: Config,
  compareRun?: string,
) {
  const id = forwardPortfolioId(config);
  return db.transaction(
    async (tx) => {
      const account = (
        await tx
          .select()
          .from(forwardAccounts)
          .where(eq(forwardAccounts.portfolioId, id))
      )[0];
      if (!account) return { portfolioId: id, status: 'NOT_INITIALIZED' };
      const { state, definition, events } =
        await createPaperRepository(tx).snapshot(id);
      const analyzer = new PerformanceAnalyzer({
        runId: id,
        paper: definition.policy,
        maxEvents: 30000,
        ...(definition.forwardExecution
          ? { execution: definition.forwardExecution }
          : {}),
      });
      for (const row of events) {
        if (row.command)
          analyzer.transition(row.command, {
            state: row.stateAfter,
            orders: row.orders,
            postings: row.postings,
            result: row.result,
          });
        analyzer.snapshot(row.stateAfter, row.stateAfter.asOf);
      }
      let cursor: string | undefined;
      for (;;) {
        const page = await tx
          .select({
            id: strategyDecisions.id,
            payload: strategyDecisions.payload,
          })
          .from(strategyDecisions)
          .where(
            and(
              eq(strategyDecisions.runId, definition.strategyRunId),
              cursor ? gt(strategyDecisions.id, cursor) : undefined,
            ),
          )
          .orderBy(asc(strategyDecisions.id))
          .limit(500);
        for (const row of page)
          analyzer.decision(strategyDecisionSchema.parse(row.payload));
        if (page.length < 500) break;
        cursor = page.at(-1)!.id;
      }
      const health =
        account.mode === 'REPLAY'
          ? replayCheckpointSchema.parse(account.checkpoint)
          : readLiveCheckpoint(account.checkpoint);
      const metrics = analyzer.finish(
        state,
        analyzer.snapshot(state, state.asOf),
        {
          quality: {
            missingHistoricalIntervals: health.gaps,
            readiness:
              account.mode === 'REPLAY'
                ? 'READY_WITH_LIMITATIONS'
                : 'INSUFFICIENT',
          },
        },
      );
      const intentStats = await tx.execute(sql`
        select count(*) filter (where kind='INTENT_OPENED')::int as accepted,
               count(*) filter (where kind='INTENT_SETTLED' and details->>'status'='FILLED')::int as filled,
               count(*) filter (where kind='INTENT_SETTLED' and details->>'status'<>'FILLED')::int as unfilled
        from forward_runtime_events
        where portfolio_id=${id} and kind in ('INTENT_OPENED','INTENT_SETTLED') and details->'intent'->>'kind'='ENTRY'
      `);
      const forward = {
        mode: account.mode,
        strategy: definition.strategyPolicy,
        risk: definition.riskPolicy,
        execution: definition.forwardExecution ?? null,
        ...comparable(
          metrics,
          Date.parse(state.asOf) - Date.parse(definition.createdAt),
        ),
      };
      const other = compareRun
        ? await createBacktestRepository(tx).result(idSchema.parse(compareRun))
        : null;
      return {
        portfolioId: id,
        metrics,
        entryIntents: intentStats.rows[0],
        forward,
        ...(other
          ? {
              historical: {
                runId: other.plan.runId,
                sourceKind: other.plan.sourceKind,
                strategy: other.plan.strategy,
                risk: other.plan.risk,
                execution: other.plan.execution ?? null,
                ...comparable(
                  other.metrics,
                  Date.parse(other.plan.endTime) -
                    Date.parse(other.plan.startTime),
                ),
              },
            }
          : {}),
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}
