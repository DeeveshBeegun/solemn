import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  createPaperRepository,
  createRiskRepository,
  createScannerRepository,
  forwardAccounts,
  listEligibleRiskCandidates,
  tokens,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import type { ScannerGap } from '@solemn/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import { createRiskAnalysisService } from '../analysis/riskAnalysisService.js';
import type { Config } from '../config/index.js';
import { policyHash, riskPolicy } from '../risk/tokenRiskEngine.js';
import { IngestionQueue } from '../scanner/ingestionQueue.js';
import type { TransportFactory } from '../scanner/pumpPortalClient.js';
import { createScannerService } from '../scanner/scannerService.js';
import { recoverPortfolio } from '../portfolio/recovery.js';
import { checkDatabaseHealth } from '../monitoring/databaseHealthMonitor.js';
import { marketHealth } from '../monitoring/marketHealthMonitor.js';
import { updateRuntimeHealth } from '../operations/runtimeHealth.js';
import { safeError } from '../services/logger.js';
import {
  equityDetails,
  finishForwardSession,
  initializeForwardAccount,
  lockForwardAccount,
  recordForwardEvent,
  reliableEquity,
} from './account.js';
import {
  admitMeteredMessage,
  budgetSchema,
  inspectTradeMessage,
  newBudget,
} from './meteredFeed.js';

const liveCheckpointSchema = z.strictObject({
  budget: budgetSchema,
  tracked: z.number().int().nonnegative(),
  lastObservationAt: z.string().nullable(),
  lastTradeAt: z.null(),
  lastMessageAt: z.string().nullable().default(null),
  lastTradeEvidenceAt: z.string().nullable().default(null),
  validationErrors: z.number().int().nonnegative().default(0),
  rateLimitEvents: z.number().int().nonnegative().default(0),
  failedPersistenceWrites: z.number().int().nonnegative().default(0),
  providerConnection: z.string().default('DISCONNECTED'),
  lastCandleAt: z.null(),
  lastSignalAt: z.null(),
  feedHealth: z.enum(['DEGRADED', 'DISCONNECTED', 'STALE']),
  gaps: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  reconnections: z.number().int().nonnegative(),
  downtimeMs: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  readiness: z.literal('NOT_READY'),
  reasons: z.array(z.string()),
});
export const readLiveCheckpoint = (input: unknown) =>
  liveCheckpointSchema.parse(input);
type TradeEvidence = NonNullable<ReturnType<typeof inspectTradeMessage>>;
type Item =
  | { kind: 'TRADE'; trade: TradeEvidence }
  | { kind: 'GAP'; gap: ScannerGap }
  | { kind: 'HEARTBEAT'; at: string };
const reasons = [
  'TRADE_CONTINUITY_UNVERIFIED',
  'POOL_CREATION_AND_EXECUTION_STATE_UNVERIFIED',
  'USD_CONVERSION_UNVERIFIED',
];

/** Live evidence collector on the existing scanner connection. Only verified normalized evidence can reach paper execution. */
export async function runLiveForward(
  ownedDb: Database,
  operationalDb: Database,
  config: Config,
  logger: Logger,
  signal: AbortSignal,
  factory?: TransportFactory,
) {
  if (
    !config.FORWARD_PAPER_ENABLED ||
    config.FORWARD_MARKET_DATA_MODE !== 'LIVE_READ_ONLY'
  )
    throw new Error('Live read-only forward mode is not enabled');
  const start = new Date().toISOString();
  const initial = readLiveCheckpoint({
    budget: newBudget(start),
    tracked: 0,
    lastObservationAt: null,
    lastTradeAt: null,
    lastCandleAt: null,
    lastSignalAt: null,
    feedHealth: 'DISCONNECTED',
    gaps: 0,
    warnings: 0,
    errors: 0,
    reconnections: 0,
    downtimeMs: 0,
    queueDepth: 0,
    readiness: 'NOT_READY',
    reasons,
  });
  const { account } = await initializeForwardAccount(
    ownedDb,
    config,
    { fingerprint: 'PUMPPORTAL_EVIDENCE_V1', start },
    initial,
  );
  const checkpoint = readLiveCheckpoint(account.checkpoint),
    budget = checkpoint.budget;
  const paper = createPaperRepository(ownedDb);
  let database = await checkDatabaseHealth(ownedDb);
  let lastProbe = Date.now();
  let recovered: Awaited<ReturnType<typeof recoverPortfolio>>;
  try {
    if (database.status !== 'HEALTHY')
      throw new Error('Forward operations database probe failed');
    recovered = await recoverPortfolio(paper, account.portfolioId);
  } catch (error) {
    await finishForwardSession(
      ownedDb,
      account,
      'HALTED',
      'LIVE_LEDGER_RECONCILIATION_FAILED',
    ).catch(() => undefined);
    throw error;
  }
  const reconciledAt = new Date().toISOString();
  // An interrupted metered lease could have unrecorded consumption. Keep the durable latch closed.
  budget.blocked ||=
    budget.armed ||
    (budget.day === start.slice(0, 10) &&
      budget.events >= config.FORWARD_DAILY_EVENT_BUDGET);
  const metered = config.ENABLE_METERED_MARKET_DATA && !budget.blocked;
  budget.armed = metered;
  checkpoint.feedHealth = 'DISCONNECTED';
  checkpoint.tracked = 0;
  checkpoint.lastTradeAt = null;
  checkpoint.lastMessageAt = null;
  checkpoint.providerConnection = 'DISCONNECTED';
  checkpoint.queueDepth = 0;
  const refreshReasons = () => [
    ...reasons,
    ...(!config.ENABLE_METERED_MARKET_DATA
      ? ['METERED_DATA_DISABLED']
      : budget.blocked
        ? ['METERED_BUDGET_LATCHED']
        : []),
  ];
  checkpoint.reasons = refreshReasons();
  await ownedDb
    .update(forwardAccounts)
    .set({ checkpoint })
    .where(eq(forwardAccounts.portfolioId, account.portfolioId));
  const controller = new AbortController(),
    stop = AbortSignal.any([signal, controller.signal]);
  let failure: unknown,
    lastReceivedAt: string | null = null,
    lastMarketAt = checkpoint.lastObservationAt,
    tracked: string[] = [],
    lastEquity = 0;
  const priorCounts = {
    validationErrors: checkpoint.validationErrors,
    rateLimitEvents: checkpoint.rateLimitEvents,
    failedPersistenceWrites: checkpoint.failedPersistenceWrites,
  };
  const fail = (error: unknown) => {
    failure ??= error;
    checkpoint.errors++;
    checkpoint.failedPersistenceWrites++;
    budget.blocked ||= budget.armed;
    logger.error(safeError(error), 'Forward feed persistence failed');
    scanner.halt();
    controller.abort();
  };
  const risk = config.TOKEN_RISK_ANALYSIS_ENABLED
    ? createRiskAnalysisService(
        config,
        createRiskRepository(operationalDb),
        logger,
      )
    : undefined;
  const queue = new IngestionQueue<Item>(
    config.SCANNER_QUEUE_CAPACITY,
    async (item) => {
      if (
        Date.now() - lastProbe >=
        config.OPERATIONS_HEALTH_CHECK_INTERVAL_SECONDS * 1000
      ) {
        database = await checkDatabaseHealth(ownedDb);
        if (database.status !== 'HEALTHY')
          throw new Error('Forward operations database probe failed');
        lastProbe = Date.now();
      }
      await ownedDb.transaction(async (tx) => {
        const row = await lockForwardAccount(tx, account.portfolioId);
        if (row.sessionId !== account.sessionId)
          throw new Error('Forward live ownership changed');
        const at = new Date().toISOString();
        if (item.kind === 'TRADE') {
          const trade = item.trade.evidence;
          if (trade.mint) {
            lastMarketAt = trade.receivedAt;
            await recordForwardEvent(
              tx,
              account,
              'LIVE_TRADE_EVIDENCE',
              item.trade.key,
              trade.receivedAt,
              trade,
            );
          }
          if (
            !trade.mint ||
            !trade.sourceAt ||
            !trade.signature ||
            !trade.trader ||
            !trade.tokenAmount ||
            !trade.solAmount ||
            !trade.poolAddress
          )
            checkpoint.warnings++;
          else checkpoint.lastTradeEvidenceAt = trade.sourceAt;
        } else if (item.kind === 'GAP') {
          const gap = item.gap;
          if (gap.endedAt) {
            if (gap.reason !== 'STARTUP') checkpoint.reconnections++;
            checkpoint.downtimeMs +=
              Date.parse(gap.endedAt) - Date.parse(gap.startedAt);
          } else checkpoint.gaps++;
          await recordForwardEvent(
            tx,
            account,
            gap.endedAt ? 'GAP_ENDED' : 'GAP_STARTED',
            gap.id,
            gap.endedAt ?? gap.startedAt,
            { ...gap },
          );
        }
        checkpoint.lastMessageAt = lastReceivedAt;
        checkpoint.lastObservationAt = lastMarketAt;
        const metrics = scanner.metrics();
        checkpoint.providerConnection = metrics.connectionStatus;
        checkpoint.validationErrors =
          priorCounts.validationErrors + metrics.rejectedMessages;
        checkpoint.rateLimitEvents =
          priorCounts.rateLimitEvents +
          metrics.rateLimitEvents +
          (risk?.metrics().rateLimitEvents ?? 0);
        checkpoint.failedPersistenceWrites = Math.max(
          checkpoint.failedPersistenceWrites,
          priorCounts.failedPersistenceWrites + metrics.failedWrites,
        );
        checkpoint.tracked = tracked.length;
        checkpoint.queueDepth = queue.depth;
        checkpoint.feedHealth =
          scanner.status !== 'CONNECTED'
            ? 'DISCONNECTED'
            : lastReceivedAt &&
                Date.parse(at) - Date.parse(lastReceivedAt) >
                  config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS * 1000
              ? 'STALE'
              : 'DEGRADED';
        checkpoint.reasons = refreshReasons();
        const loaded = await createPaperRepository(tx).load(
          account.portfolioId,
        );
        const health = marketHealth({
          connected: scanner.status === 'CONNECTED',
          at,
          lastValidTrade: null,
          maxAgeSeconds: config.FORWARD_MAX_MARKET_DATA_AGE_SECONDS,
          indicatorsReady: false,
          executableQuote: false,
          verified: false,
          queueDepth: queue.depth,
          queueCapacity: config.SCANNER_QUEUE_CAPACITY,
          maxQueuePercent: config.OPERATIONS_MAX_QUEUE_UTILIZATION_PERCENT,
        });
        await updateRuntimeHealth(
          tx,
          row,
          loaded.state,
          {
            ...health,
            checkedAt: at,
            sourceAt: at,
            reconciledAt,
            database: database.status,
            queryMs: database.queryMs,
            queueDepth: queue.depth,
            protectiveExits: false,
          },
          config.OPERATIONS_OUTAGE_ALERT_SECONDS * 1000,
          reliableEquity(loaded.state),
        );
        if (
          item.kind === 'HEARTBEAT' &&
          Date.parse(item.at) - lastEquity >=
            config.FORWARD_EQUITY_SNAPSHOT_INTERVAL_SECONDS * 1000
        ) {
          await recordForwardEvent(
            tx,
            account,
            'EQUITY',
            item.at,
            item.at,
            equityDetails(loaded.state, loaded.definition),
          );
          lastEquity = Date.parse(item.at);
        }
        await tx
          .update(forwardAccounts)
          .set({ checkpoint })
          .where(eq(forwardAccounts.portfolioId, account.portfolioId));
      });
    },
    (_item, error) => fail(error),
    () => {
      failure ??= new Error('Forward evidence drain incomplete');
      budget.blocked ||= budget.armed;
    },
  );
  // Use a credential only when this session can admit metered trades.
  const url = new URL(config.PUMPPORTAL_WS_URL);
  url.search = '';
  const scanner = createScannerService(
    {
      ...config,
      SCANNER_ENABLED: true,
      SCANNER_SUBSCRIBE_NEW_TOKENS: true,
      SCANNER_SUBSCRIBE_MIGRATIONS: true,
      PUMPPORTAL_WS_URL: url.toString(),
      PUMPPORTAL_API_KEY: metered ? config.PUMPPORTAL_API_KEY : '',
    },
    createScannerRepository(operationalDb, { requestRiskAnalysis: !!risk }),
    logger,
    factory,
    (event) => {
      lastMarketAt = event.event.ingestedAt;
      risk?.notify(
        event.event.tokenMint,
        event.event.eventType === 'TOKEN_MIGRATED',
      );
    },
    {
      message(raw) {
        const at = new Date().toISOString();
        lastReceivedAt = at;
        if (!metered) return 'UNHANDLED';
        const trade = inspectTradeMessage(
          raw,
          at,
          config.SCANNER_MAX_MESSAGE_BYTES,
        );
        if (!trade) return 'UNHANDLED';
        if (!admitMeteredMessage(budget, at, config.FORWARD_DAILY_EVENT_BUDGET))
          return 'BUDGET_EXHAUSTED';
        if (!queue.offer({ kind: 'TRADE', trade })) {
          failure ??= new Error('Forward trade evidence queue saturated');
          budget.blocked = true;
          controller.abort();
          return 'QUEUE_SATURATED';
        }
        return budget.blocked ? 'BUDGET_EXHAUSTED' : 'ACCEPTED';
      },
      gap(gap) {
        if (!queue.offer({ kind: 'GAP', gap }, true)) {
          failure ??= new Error('Forward gap queue saturated');
          budget.blocked ||= budget.armed;
          controller.abort();
        }
      },
    },
  );
  const held = [
    ...new Set(
      recovered.state.positions
        .filter((p) => p.status !== 'CLOSED')
        .map((p) => p.mint),
    ),
  ];
  logger.info(
    {
      portfolioId: account.portfolioId,
      sessionId: account.sessionId,
      readiness: 'NOT_READY',
      metered,
      reasons: checkpoint.reasons,
    },
    'Forward live evidence collector started',
  );
  try {
    await risk?.start();
    if (!stop.aborted) await scanner.start();
    while (!stop.aborted) {
      const at = new Date().toISOString();
      if (metered && !budget.blocked) {
        const eligible = await listEligibleRiskCandidates(
          operationalDb,
          at,
          policyHash(riskPolicy(config)),
          100,
        );
        const cutoff = new Date(
          Date.parse(at) - config.STRATEGY_MAX_POOL_AGE_MINUTES * 60000,
        ).toISOString();
        const candidates = eligible.length
          ? await operationalDb
              .select({ mint: tokens.mintAddress })
              .from(tokens)
              .where(
                and(
                  inArray(
                    tokens.mintAddress,
                    eligible.map((c) => c.tokenMint),
                  ),
                  gte(tokens.discoveredAt, cutoff),
                ),
              )
              .orderBy(tokens.mintAddress)
          : [];
        const selected = [
          ...new Set([...held, ...candidates.map((c) => c.mint)]),
        ].slice(0, config.FORWARD_MAX_TRACKED_TOKENS);
        if (held.length > selected.length)
          logger.warn(
            { held: held.length, tracked: selected.length },
            'Some positions exceed live subscription capacity',
          );
        if (!stop.aborted && !budget.blocked) {
          tracked = selected;
          scanner.watchTrades(tracked);
        }
      } else tracked = [];
      if (!queue.offer({ kind: 'HEARTBEAT', at }, true))
        throw new Error('Forward heartbeat queue saturated');
      await sleep(2000, undefined, { signal: stop }).catch((error) => {
        if (!stop.aborted) throw error;
      });
    }
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      await scanner.stop();
    } catch (error) {
      failure ??= error;
    }
    try {
      await risk?.stop();
    } catch (error) {
      failure ??= error;
    }
    try {
      await queue.stopAndDrain(config.SCANNER_DRAIN_TIMEOUT_MS);
    } catch (error) {
      failure ??= error;
    }
    if (
      signal.aborted &&
      signal.reason instanceof Error &&
      signal.reason.name !== 'AbortError'
    )
      failure ??= signal.reason;
    if (!failure) budget.armed = false;
    else budget.blocked ||= budget.armed;
    checkpoint.tracked = 0;
    checkpoint.queueDepth = 0;
    checkpoint.feedHealth = 'DISCONNECTED';
    checkpoint.providerConnection = 'DISCONNECTED';
    checkpoint.reasons = refreshReasons();
    try {
      await ownedDb
        .update(forwardAccounts)
        .set({ checkpoint })
        .where(eq(forwardAccounts.sessionId, account.sessionId));
      await finishForwardSession(
        ownedDb,
        account,
        failure ? 'HALTED' : 'STOPPED',
        failure ? 'FORWARD_LIVE_FAILURE' : 'SHUTDOWN',
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return {
    portfolioId: account.portfolioId,
    sessionId: account.sessionId,
    readiness: 'NOT_READY',
    checkpoint,
  };
}
