import { eq } from 'drizzle-orm';
import {
  createPaperRepository,
  createStrategyRepository,
  forwardAccounts,
  tokens,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableHash, stableId } from '@solemn/shared';
import type { PaperCommand } from '@solemn/shared';
import type { Logger } from 'pino';
import { SimulationClock } from '../backtesting/clock.js';
import type { Config } from '../config/index.js';
import { applyPaperCommand } from '../portfolio/portfolioManager.js';
import { recoverPortfolio } from '../portfolio/recovery.js';
import { marketHealth } from '../monitoring/marketHealthMonitor.js';
import { checkDatabaseHealth } from '../monitoring/databaseHealthMonitor.js';
import {
  riskHaltReason,
  updateRuntimeHealth,
} from '../operations/runtimeHealth.js';
import { verifyForwardCheckpoint } from '../operations/portfolioReconciler.js';
import { safeError } from '../services/logger.js';
import {
  evaluateSignal,
  initialStrategyState,
} from '../strategy/signalEngine.js';
import {
  beginForwardShutdown,
  equityDetails,
  finishForwardSession,
  initializeForwardAccount,
  lockForwardAccount,
  recordForwardEvent,
  reliableEquity,
} from './account.js';
import { CandidateManager } from './candidateManager.js';
import {
  initialReplayCheckpoint,
  replayCheckpointSchema,
} from './checkpoint.js';
import { ForwardPaperFlow } from './paperFlow.js';
import type { ForwardFrame, ReplayProvider } from './replayProvider.js';

/** A committed source frame advances the financial ledger, intent journal and cursor together. */
export async function runForwardReplay(
  db: Database,
  config: Config,
  provider: ReplayProvider,
  logger: Logger,
  signal?: AbortSignal,
  onFrame?: (frame: ForwardFrame) => void | Promise<void>,
) {
  if (
    !config.FORWARD_PAPER_ENABLED ||
    config.FORWARD_MARKET_DATA_MODE !== 'REPLAY'
  )
    throw new Error('Forward replay is not enabled');
  const { account, strategyRun } = await initializeForwardAccount(
    db,
    config,
    { fingerprint: provider.fingerprint, start: provider.startTime },
    initialReplayCheckpoint(),
  );
  let reconciling = true;
  try {
    let database = await checkDatabaseHealth(db);
    if (database.status !== 'HEALTHY')
      throw new Error('Forward operations database probe failed');
    let lastProbe = Date.now();
    const repository = createPaperRepository(db),
      journal = await repository.snapshot(account.portfolioId);
    const recovered = await recoverPortfolio(
      repository,
      account.portfolioId,
      journal,
    );
    const { definition } = recovered,
      checkpoint = replayCheckpointSchema.parse(account.checkpoint);
    const watch = new CandidateManager(provider.markets, config),
      clock = new SimulationClock(provider.startTime);
    let prior = journal.events[0]!.stateAfter,
      index = 1,
      cursorFound = checkpoint.cursor === null;
    verifyForwardCheckpoint(account, recovered.state);
    const reconciledAt = new Date().toISOString();
    reconciling = false;
    logger.info(
      {
        portfolioId: account.portfolioId,
        sessionId: account.sessionId,
        positions: recovered.state.positions.length,
        cursor: checkpoint.cursor,
      },
      'Forward portfolio recovered',
    );
    for await (const frame of provider.frames()) {
      if (signal?.aborted) break;
      clock.advance(frame.at);
      if (checkpoint.cursor && frame.at <= checkpoint.cursor) {
        if (frame.at === checkpoint.cursor) cursorFound = true;
        watch.ingest(frame, prior.positions);
        if (frame.candleEnd)
          for (const market of watch.monitored.values())
            watch.finalize(market, frame.candleEnd, frame.at);
        while (
          index < journal.events.length &&
          Date.parse(journal.events[index]!.timestamp) <= Date.parse(frame.at)
        )
          prior = journal.events[index++]!.stateAfter;
        continue;
      }
      if (!cursorFound)
        throw new Error('Forward cursor is outside its immutable tape');
      if (
        Date.now() - lastProbe >=
        config.OPERATIONS_HEALTH_CHECK_INTERVAL_SECONDS * 1000
      ) {
        database = await checkDatabaseHealth(db);
        if (database.status !== 'HEALTHY')
          throw new Error('Forward operations database probe failed');
        lastProbe = Date.now();
      }
      await db.transaction(async (tx) => {
        let row = await lockForwardAccount(tx, account.portfolioId);
        if (row.sessionId !== account.sessionId)
          throw new Error('Forward session ownership changed');
        const paper = createPaperRepository(tx),
          strategy = createStrategyRepository(tx),
          loaded = await paper.load(account.portfolioId);
        // Administrative commands may have invalidated unfilled entries since the last frame.
        checkpoint.pending = replayCheckpointSchema.parse(
          row.checkpoint,
        ).pending;
        let state = loaded.state;
        const at = clock.now().toISOString();
        const record = (
          kind: string,
          key: string,
          details: Record<string, unknown>,
        ) => recordForwardEvent(tx, account, kind, key, at, details);
        const commit = async (command: PaperCommand) => {
          const result = await paper.transact(
            account.portfolioId,
            command,
            (current, actual) => {
              if (
                stableHash(actual) !== stableHash(definition) ||
                stableHash(current) !== stableHash(state)
              )
                throw new Error('Forward ledger frontier changed');
              return applyPaperCommand(current, command, actual);
            },
          );
          if (result.duplicate)
            throw new Error('Forward cursor and ledger disagree');
          state = result.state;
          if (result.orders.length || command.type === 'EXIT_UNAVAILABLE') {
            await record('PAPER_RESULT', command.id, {
              result: result.result,
              orderIds: result.orders.map((r) => r.order.id),
            });
            logger.info(
              {
                portfolioId: account.portfolioId,
                sessionId: account.sessionId,
                at,
                outcome: result.result.outcome,
                reasons: result.result.reasons,
                orderId: result.result.orderId,
              },
              'Forward paper operation',
            );
          }
          return result;
        };
        const flow = new ForwardPaperFlow(
          definition,
          checkpoint,
          watch,
          () => state,
          commit,
          record,
        );
        const { changes, quotes, conflicts } = watch.ingest(
          frame,
          state.positions,
        );
        checkpoint.warnings += conflicts;
        for (const change of changes)
          await record(change.action, `${at}:${change.key}`, change);
        for (const event of frame.events) {
          if (event.kind === 'DISCOVERY') {
            await tx
              .insert(tokens)
              .values({
                mintAddress: event.mint,
                sourcePlatform: 'PAPER_FIXTURE',
                discoveredAt: at,
                riskStatus: 'UNKNOWN',
              })
              .onConflictDoNothing();
            await record('FIXTURE_DISCOVERY', event.id, {
              mint: event.mint,
              poolAddress: event.poolAddress,
            });
          }
          if (
            event.kind === 'RISK' &&
            event.data.currentStatus === 'REJECTED' &&
            state.positions.some(
              (p) => p.mint === event.mint && p.status !== 'CLOSED',
            )
          )
            await record('CRITICAL_RISK', event.id, {
              mint: event.mint,
              risk: event.data,
            });
        }
        if (frame.gap && !frame.connected) {
          checkpoint.gaps++;
          checkpoint.warnings++;
          checkpoint.lastTradeAt = null;
          logger.warn(
            {
              portfolioId: account.portfolioId,
              sessionId: account.sessionId,
              at,
              reason: frame.gap.reason,
            },
            'Forward replay feed disconnected',
          );
          await record('GAP_STARTED', frame.gap.start, {
            ...frame.gap,
            end: null,
          });
          await commit({
            type: 'FEED_UNAVAILABLE',
            id: stableId(['forward-gap-mark-v1', account.portfolioId, at]),
            at,
            reason: frame.gap.reason,
          });
          await flow.cancel(at, 'FEED_DISCONNECTED');
        }
        if (frame.gap && frame.connected) {
          checkpoint.reconnections++;
          checkpoint.downtimeMs +=
            Date.parse(frame.gap.end) - Date.parse(frame.gap.start);
          await record('GAP_ENDED', frame.gap.start, { ...frame.gap });
          logger.info(
            {
              portfolioId: account.portfolioId,
              sessionId: account.sessionId,
              at,
            },
            'Forward replay feed restored',
          );
        }
        checkpoint.connected = frame.connected;
        checkpoint.tracked = watch.monitored.size;
        checkpoint.lastTradeAt =
          [...watch.monitored.values()]
            .map((m) => m.lastTradeAt)
            .filter((t) => t !== null)
            .sort()
            .at(-1) ?? null;
        if (quotes.length) checkpoint.lastObservationAt = at;
        const candles = frame.candleEnd
          ? [...watch.monitored].map(([key, market]) => ({
              key,
              market,
              candle: watch.finalize(market, frame.candleEnd!, at),
            }))
          : [];
        const markets = [...watch.monitored.values()];
        const fresh = markets.some((market) => watch.fresh(market, at));
        const verifiedQuote = markets.some((market) =>
          flow.quoteReady(market.quote, at),
        );
        const currentHealth = marketHealth({
          connected: frame.connected,
          at,
          lastValidTrade: checkpoint.lastTradeAt,
          maxAgeSeconds: config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS,
          verified: true,
          indicatorsReady: markets.some(
            (market) =>
              watch.entryReady(market, at) && flow.quoteReady(market.quote, at),
          ),
          executableQuote: verifiedQuote,
        });
        const equityReliableAt = () =>
          reliableEquity(state) &&
          state.positions.every(
            (position) =>
              position.status === 'CLOSED' ||
              (position.mark !== null &&
                Date.parse(at) - Date.parse(position.mark.observedAt) <=
                  definition.policy.maxPriceAgeSeconds * 1000),
          );
        const health = {
          ...currentHealth,
          checkedAt: new Date().toISOString(),
          sourceAt: at,
          reconciledAt,
          database: database.status,
          queryMs: database.queryMs,
          queueDepth: null,
          protectiveExits:
            frame.connected && verifiedQuote && equityReliableAt(),
        };
        const priorStatus = row.status;
        row = await updateRuntimeHealth(
          tx,
          row,
          state,
          health,
          config.OPERATIONS_OUTAGE_ALERT_SECONDS * 1000,
          equityReliableAt(),
        );
        // A signal can wait for its first quote. Only the fresh executable frame can land it.
        const allowIntents = () =>
          frame.connected &&
          fresh &&
          row.status !== 'PAUSED' &&
          row.status !== 'HALTED' &&
          state.status === 'ACTIVE' &&
          equityReliableAt() &&
          !signal?.aborted;
        const allowEntries = () => row.status === 'RUNNING' && allowIntents();
        if (frame.candleEnd) {
          for (const { key, market, candle } of candles) {
            const corrections = market.builder.visibleCorrections(at);
            if (candle.complete && !candle.issues.length)
              checkpoint.lastCandleAt = frame.candleEnd;
            const decision = evaluateSignal(
              {
                runId: strategyRun.id,
                mint: market.market.mint,
                poolAddress: market.market.poolAddress,
                poolCreatedAt:
                  market.market.poolCreationAvailableAt &&
                  market.market.poolCreationAvailableAt <= at
                    ? market.market.poolCreatedAt
                    : null,
                asOf: at,
                candleEnd: frame.candleEnd,
                candles: market.candles,
                risk: market.risk,
                feedHealthy:
                  allowIntents() && watch.fresh(market, at) && candle.complete,
                lastMarketUpdateAt: market.lastTradeAt,
                corrections,
                sourceRefs: [
                  ...market.candles.map((c) => c.id),
                  ...candle.tradeIds,
                  ...market.coverage.map((c) => c.id),
                  ...(market.risk?.assessment
                    ? [market.risk.assessment.id]
                    : []),
                ],
              },
              checkpoint.states[key] ?? initialStrategyState(),
              config,
            );
            await strategy.save(strategyRun, decision, [candle], corrections);
            checkpoint.states[key] = decision.stateAfter;
            if (decision.candidate) {
              checkpoint.signals++;
              checkpoint.lastSignalAt = at;
              await record('SIGNAL', decision.candidate.id, {
                mint: decision.mint,
                signalId: decision.candidate.id,
                strategyVersion: strategyRun.strategyVersion,
              });
              logger.info(
                {
                  portfolioId: account.portfolioId,
                  sessionId: account.sessionId,
                  at,
                  mint: decision.mint,
                  signalId: decision.candidate.id,
                  strategyVersion: strategyRun.strategyVersion,
                },
                'Forward BUY_CANDIDATE generated',
              );
              await flow.queueEntry(decision.candidate, at);
            }
          }
        }
        await flow.advance(at, allowIntents());
        if (frame.connected)
          for (const quote of quotes)
            await flow.observe(quote, at, allowEntries());
        if (frame.final) await flow.cancel(at, 'REPLAY_TAPE_ENDED');
        const newlyStale = state.positions.some(
          (p) =>
            p.status !== 'CLOSED' &&
            !p.valuationStale &&
            p.mark &&
            Date.parse(at) - Date.parse(p.mark.observedAt) >
              definition.policy.maxPriceAgeSeconds * 1000,
        );
        if (frame.snapshot || newlyStale) {
          await commit({
            type: 'TICK',
            id: stableId(['forward-tick-v1', account.portfolioId, at]),
            at,
          });
          await record('EQUITY', at, equityDetails(state, definition));
        }
        checkpoint.cursor = at;
        checkpoint.feedHealth = !frame.connected
          ? 'DISCONNECTED'
          : !fresh
            ? 'STALE'
            : quotes.length ||
                [...watch.monitored.values()].some(
                  (m) =>
                    m.quote &&
                    Date.parse(at) - Date.parse(m.quote.observedAt) <=
                      config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS * 1000,
                )
              ? 'HEALTHY'
              : 'DEGRADED';
        if (
          row.status === 'HALTED' ||
          row.status === 'PAUSED' ||
          riskHaltReason(state, equityReliableAt())
        )
          await flow.cancel(at, 'OPERATIONAL_ENTRY_GATE_CLOSED', true);
        const [saved] = await tx
          .update(forwardAccounts)
          .set({ checkpoint: replayCheckpointSchema.parse(checkpoint) })
          .where(eq(forwardAccounts.portfolioId, account.portfolioId))
          .returning();
        if (!saved) throw new Error('Missing forward account');
        if (
          riskHaltReason(state, equityReliableAt()) ||
          (row.status === 'RUNNING' && !allowEntries()) ||
          health.protectiveExits !==
            (frame.connected && verifiedQuote && equityReliableAt()) ||
          loaded.state.positions.some((p) => p.status === 'EXIT_BLOCKED') !==
            state.positions.some((p) => p.status === 'EXIT_BLOCKED')
        )
          row = await updateRuntimeHealth(
            tx,
            saved,
            state,
            {
              ...health,
              protectiveExits:
                frame.connected && verifiedQuote && equityReliableAt(),
            },
            config.OPERATIONS_OUTAGE_ALERT_SECONDS * 1000,
            equityReliableAt(),
          );
        if (priorStatus !== row.status)
          logger.info(
            {
              portfolioId: row.portfolioId,
              sessionId: row.sessionId,
              status: row.status,
              reason: row.opsReason,
            },
            'Forward operational state evaluated',
          );
      });
      await onFrame?.(frame);
    }
    if (!signal?.aborted && !cursorFound)
      throw new Error('Forward cursor is outside its immutable tape');
    if (
      signal?.aborted &&
      signal.reason instanceof Error &&
      signal.reason.name !== 'AbortError'
    )
      throw signal.reason;
    await beginForwardShutdown(db, account);
    reconciling = true;
    const final = await recoverPortfolio(repository, account.portfolioId);
    reconciling = false;
    await finishForwardSession(
      db,
      account,
      'STOPPED',
      signal?.aborted ? 'SHUTDOWN' : 'REPLAY_COMPLETE',
    );
    return {
      portfolioId: account.portfolioId,
      sessionId: account.sessionId,
      checkpoint,
      ...equityDetails(final.state, final.definition),
    };
  } catch (error) {
    const reason = reconciling
      ? 'FORWARD_LEDGER_RECONCILIATION_FAILED'
      : 'FORWARD_FRAME_OR_RUNTIME_FAILED';
    logger.error(
      { ...safeError(error), portfolioId: account.portfolioId, reason },
      'Forward halted after failure',
    );
    await finishForwardSession(db, account, 'HALTED', reason).catch(() =>
      logger.error(
        { portfolioId: account.portfolioId, reason },
        'Forward halt could not be durably audited',
      ),
    );
    throw error;
  }
}
