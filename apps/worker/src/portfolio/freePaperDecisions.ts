import { and, desc, eq, sql } from 'drizzle-orm';
import {
  createPaperRepository,
  createStrategyRepository,
  currentStrategyRisks,
  marketCandles,
  marketTradeObservations,
  paperPortfolios,
  strategyDecisions,
  strategyRun,
} from '@solemn/database';
import type { createDatabase, Database, StrategyRun } from '@solemn/database';
import {
  paperAccountDefinitionSchema,
  stableHash,
  stableId,
  strategyDecisionSchema,
  strategyStateSchema,
} from '@solemn/shared';
import type {
  MarketCandle,
  PaperAccountDefinition,
  StrategyRiskContext,
  StrategyState,
  TokenRiskAssessment,
} from '@solemn/shared';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import {
  GeckoPublicClient,
  FreeMarketError,
} from '../market/freeGeckoClient.js';
import type {
  FreeMarketClient,
  FreeMarketSnapshot,
} from '../market/freeGeckoClient.js';
import {
  initialStrategyState,
  evaluateSignal,
  strategyPolicy,
} from '../strategy/signalEngine.js';
import { riskPolicy, policyHash } from '../risk/tokenRiskEngine.js';
import { entryRiskReasons } from '../risk/riskManager.js';
import { providerError } from '../analysis/httpReader.js';
import { paperPolicy } from './policy.js';
import { initialPortfolio, initialPosting } from './accountingService.js';
import { createFreePaperExecutor } from './freePaperExecutor.js';

export function freePaperProfile(config: Config, createdAt: string) {
  const policy = strategyPolicy(config),
    risk = riskPolicy(config);
  const execution = config.LIVE_PAPER_EXECUTION_ENABLED
    ? {
        freeExecution: {
          model: 'FREE_PUBLIC_SPOT_V1' as const,
          source: 'GECKOTERMINAL_PUBLIC' as const,
        },
      }
    : {};
  const profile = stableHash({
    name: config.FREE_PAPER_ACCOUNT_NAME,
    provider: config.GECKOTERMINAL_BASE_URL,
    policy,
    risk,
    paper: paperPolicy(config),
    ...execution,
  });
  const run: StrategyRun = {
    ...strategyRun(policy, policyHash(risk), null),
    id: stableId(['free-live-strategy-v1', profile]),
    mode: 'LIVE_PAPER',
  };
  const configuration = {
    policy: paperPolicy(config),
    strategyPolicy: policy,
    riskPolicy: risk,
    strategyRunId: run.id,
    replayHash: stableHash([
      'FREE_LIVE_DECISIONS',
      config.GECKOTERMINAL_BASE_URL,
    ]),
    ...execution,
  };
  const definition = paperAccountDefinitionSchema.parse({
    ...configuration,
    id: stableId(['free-live-account-v1', profile]),
    name: config.FREE_PAPER_ACCOUNT_NAME,
    mode: 'PAPER',
    currency: 'USD',
    dataMode: 'FORWARD_LIVE',
    createdAt,
    configHash: stableHash(configuration),
  });
  return { run, definition };
}

export function evaluateFreePaperSnapshot(
  config: Config,
  runId: string,
  input: FreeMarketSnapshot,
  risk: StrategyRiskContext | null,
  previous: StrategyState,
  asOf: string,
) {
  const current = input.candles.at(-1);
  const issues = [
    ...new Set(input.candles.slice(-10).flatMap((c) => c.issues)),
  ];
  if (
    input.trades.some(
      (trade) =>
        trade.rawPayload.isAnomalous === true &&
        Date.parse(trade.timestamp) > Date.parse(asOf) - 180000,
    )
  )
    issues.push('FREE_RECENT_ANOMALOUS_TRADE');
  if (!current || Date.parse(asOf) - Date.parse(current.endTime) > 180000)
    issues.push('FREE_COMPLETED_CANDLES_STALE');
  const decision = evaluateSignal(
    {
      runId,
      mint: input.mint,
      poolAddress: input.pool,
      poolCreatedAt: input.poolCreatedAt,
      asOf,
      candleEnd: current?.endTime ?? asOf,
      candles: input.candles,
      risk,
      feedHealthy: issues.length === 0,
      lastMarketUpdateAt: input.lastTradeAt,
      corrections: [],
      dataMode: 'LIVE_PAPER',
      sourceRefs: [
        ...input.candles.map((c) => c.id),
        ...input.trades.map((t) => t.id),
      ],
    },
    previous,
    config,
  );
  if (issues.length && decision.outcome !== 'BLOCKED_BY_RISK')
    return strategyDecisionSchema.parse({
      ...decision,
      outcome: 'INSUFFICIENT_DATA',
      candidate: null,
      reasons: [...new Set([...decision.reasons, ...issues])],
      explanation: [...new Set([...decision.reasons, ...issues])].join('; '),
    });
  return decision;
}

type Options = { client?: FreeMarketClient; now?: () => number };
export function createFreePaperDecisionService(
  config: Config,
  database: ReturnType<typeof createDatabase>,
  logger: Logger,
  options: Options = {},
) {
  const now = options.now ?? Date.now;
  const client = options.client ?? new GeckoPublicClient(config);
  const controller = new AbortController();
  const profile = freePaperProfile(config, new Date(now()).toISOString());
  let definition: PaperAccountDefinition = profile.definition;
  let lease:
    Awaited<ReturnType<typeof database.acquireForwardOwnership>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let started = false,
    stopped = false,
    status = 'DISABLED';
  let cursor = 0;
  const timestamp = () => new Date(now()).toISOString();
  const executor = config.LIVE_PAPER_EXECUTION_ENABLED
    ? createFreePaperExecutor(profile.definition, logger, timestamp)
    : undefined;
  async function risks(db: Database) {
    const candidates = await currentStrategyRisks(
      db,
      timestamp(),
      policyHash(riskPolicy(config)),
      100,
    );
    if (!candidates.length) return [];
    const live = await db.execute<{
      mint: string;
    }>(sql`SELECT mint_address AS mint FROM tokens WHERE mint_address IN (${sql.join(
      candidates.map((r) => sql`${r.tokenMint}`),
      sql`,`,
    )})
      AND lower(source_platform) !~ '(fixture|synthetic|replay|^test($|_))'
      AND discovered_at>=${timestamp()}::timestamptz-(${config.STRATEGY_MAX_POOL_AGE_MINUTES}::text||' minutes')::interval
      ORDER BY discovered_at DESC,mint_address`);
    const byMint = new Map(candidates.map((r) => [r.tokenMint, r]));
    return live.rows.map((r) => byMint.get(r.mint)!);
  }
  async function latest(db: Database, mint: string, pool?: string) {
    const row = (
      await db
        .select({ payload: strategyDecisions.payload })
        .from(strategyDecisions)
        .where(
          and(
            eq(strategyDecisions.runId, profile.run.id),
            eq(strategyDecisions.tokenMint, mint),
            pool ? eq(strategyDecisions.poolAddress, pool) : undefined,
          ),
        )
        .orderBy(desc(strategyDecisions.timestamp), desc(strategyDecisions.id))
        .limit(1)
    )[0];
    return row?.payload;
  }
  async function unavailable(
    db: Database,
    mint: string,
    risk: TokenRiskAssessment | null,
    reason: string,
  ) {
    const prior = await latest(db, mint);
    const state = initialStrategyState();
    const asOf = timestamp();
    state.lastSignalAt = prior?.stateAfter.lastSignalAt ?? null;
    const decision = strategyDecisionSchema.parse({
      id: stableId([
        'free-live-unavailable',
        profile.run.id,
        mint,
        risk?.id ?? 'none',
        reason,
      ]),
      runId: profile.run.id,
      mint,
      poolAddress: prior?.poolAddress ?? null,
      timestamp: asOf,
      candleId: null,
      outcome: risk ? 'INSUFFICIENT_DATA' : 'BLOCKED_BY_RISK',
      reasons: [reason],
      explanation: reason,
      features: null,
      stateBefore: prior?.stateAfter ?? state,
      stateAfter: state,
      transitions: [],
      risk: risk
        ? {
            currentStatus: 'ELIGIBLE',
            currentRequestId: risk.requestId,
            assessment: risk,
            availableAt: asOf,
          }
        : null,
      sourceRefs: [],
      candidate: null,
    });
    await createStrategyRepository(db).save(profile.run, decision, [], []);
  }
  async function evaluate(db: Database, snapshot: FreeMarketSnapshot) {
    await db.transaction(
      async (tx) => {
        const eligible = (await risks(tx)).find(
          (r) => r.tokenMint === snapshot.mint,
        );
        if (!eligible) {
          await unavailable(
            tx,
            snapshot.mint,
            null,
            'TOKEN_RISK_NO_LONGER_ELIGIBLE',
          );
          return;
        }
        const prior = await latest(tx, snapshot.mint, snapshot.pool);
        const published = await tx
          .select({ payload: marketCandles.payload })
          .from(marketCandles)
          .where(
            and(
              eq(marketCandles.runId, profile.run.id),
              eq(marketCandles.tokenMint, snapshot.mint),
              eq(marketCandles.poolAddress, snapshot.pool),
            ),
          )
          .orderBy(desc(marketCandles.endTime))
          .limit(20);
        const frozen = new Map(
          published.map((c) => [c.payload.startTime, c.payload]),
        );
        const current = snapshot.candles.at(-1);
        if (!current) return;
        const previousEnd = prior?.candleId
          ? published.find((c) => c.payload.id === prior.candleId)?.payload
              .endTime
          : null;
        if (
          previousEnd &&
          Date.parse(current.endTime) <= Date.parse(previousEnd)
        )
          return;
        let revised = false;
        const candles: MarketCandle[] = snapshot.candles.map((c) => {
          const stored = frozen.get(c.startTime);
          if (!stored) return c;
          if (c.complete && stored.complete && c.id !== stored.id)
            revised = true;
          // The first recorded finalized observation stays immutable.
          return stored;
        });
        if (revised) {
          await unavailable(
            tx,
            snapshot.mint,
            eligible,
            'FREE_FINALIZED_SOURCE_REVISED',
          );
          return;
        }
        const before = prior
          ? strategyStateSchema.parse(prior.stateAfter)
          : initialStrategyState();
        if (
          previousEnd &&
          Date.parse(current.endTime) - Date.parse(previousEnd) > 60000
        )
          before.breakout = initialStrategyState().breakout;
        const risk: StrategyRiskContext = {
          currentStatus: 'ELIGIBLE',
          currentRequestId: eligible.requestId,
          assessment: eligible,
          availableAt: timestamp(),
        };
        let decision = evaluateFreePaperSnapshot(
          config,
          profile.run.id,
          { ...snapshot, candles },
          risk,
          before,
          timestamp(),
        );
        if (decision.candidate) {
          const state = (await createPaperRepository(tx).load(definition.id))
            .state;
          const reasons = entryRiskReasons(
            {
              type: 'ENTRY',
              id: stableId([
                'paper-entry-v1',
                definition.id,
                decision.candidate.id,
              ]),
              at: decision.timestamp,
              candidate: decision.candidate,
              risk,
              observation: null,
            },
            state,
            definition,
          );
          if (reasons.length)
            decision = strategyDecisionSchema.parse({
              ...decision,
              outcome: 'BLOCKED_BY_RISK',
              candidate: null,
              reasons,
              explanation: reasons.join('; '),
              stateAfter: {
                ...initialStrategyState(),
                lastSignalAt: before.lastSignalAt,
              },
            });
        }
        if (snapshot.trades.length)
          await tx
            .insert(marketTradeObservations)
            .values(
              snapshot.trades.map((trade) => ({
                runId: profile.run.id,
                id: trade.id,
                tokenMint: trade.mint,
                poolAddress: trade.poolAddress,
                source: trade.source,
                sourceEventId: trade.sourceEventId,
                timestamp: trade.timestamp,
                receivedAt: trade.receivedAt,
                payload: trade,
              })),
            )
            .onConflictDoNothing();
        // Save only finalized source bars. Incomplete observations are retained in the decision's feature evidence.
        const toSave = candles
          .filter((c) => c.complete || c.id === decision.candleId)
          .map((c) => frozen.get(c.startTime) ?? c);
        const selected = toSave.find((c) => c.startTime === current.startTime);
        if (selected && selected.id !== decision.candleId)
          decision = strategyDecisionSchema.parse({
            ...decision,
            candleId: selected.id,
          });
        await createStrategyRepository(tx).save(
          profile.run,
          decision,
          toSave,
          [],
        );
        status =
          decision.outcome === 'BUY_CANDIDATE'
            ? 'LIVE_DECISION_RECORDED'
            : decision.outcome === 'INSUFFICIENT_DATA'
              ? 'WAITING_FOR_MARKET_DATA'
              : 'LIVE_FREE_EVALUATING';
        logger.info(
          {
            portfolioId: definition.id,
            mint: snapshot.mint,
            status: decision.outcome,
            reason: decision.reasons.join(','),
          },
          decision.candidate
            ? 'Live paper entry decision recorded'
            : 'Free live paper market evaluated',
        );
      },
      { isolationLevel: 'repeatable read' },
    );
  }
  async function poll() {
    const db = lease!.db;
    await executor?.expire(db);
    const eligible = await risks(db);
    const positions = executor
      ? (
          await createPaperRepository(db).load(definition.id)
        ).state.positions.filter((p) => p.status !== 'CLOSED')
      : [];
    if (!eligible.length && !positions.length) {
      status = 'WAITING_FOR_ELIGIBLE_TOKENS';
      logger.info(
        { portfolioId: definition.id, status },
        'Free live paper decisions waiting for eligible tokens',
      );
      return;
    }
    const targets = [
      ...positions.map((p) => ({ tokenMint: p.mint, pool: p.poolAddress })),
      ...eligible
        .filter((r) => !positions.some((p) => p.mint === r.tokenMint))
        .map((r) => ({ tokenMint: r.tokenMint, pool: undefined })),
    ];
    const selected = Array.from(
      {
        length: Math.min(targets.length, config.FREE_MARKET_MAX_TRACKED_TOKENS),
      },
      (_, i) => targets[(cursor + i) % targets.length]!,
    );
    cursor = (cursor + selected.length) % targets.length;
    for (const candidate of selected) {
      if (controller.signal.aborted || lease?.signal.aborted) return;
      try {
        status = 'LIVE_FREE_EVALUATING';
        const snapshot = await client.read(
          candidate.tokenMint,
          AbortSignal.any([controller.signal, lease!.signal]),
          candidate.pool,
        );
        await executor?.process(db, snapshot);
        await evaluate(db, snapshot);
      } catch (error) {
        if (controller.signal.aborted || lease?.signal.aborted) return;
        status = 'WAITING_FOR_MARKET_DATA';
        const reason =
          error instanceof FreeMarketError
            ? error.message
            : 'FREE_MARKET_' + providerError(error).code;
        await executor?.unavailable(db, candidate.tokenMint, reason);
        await unavailable(
          db,
          candidate.tokenMint,
          (await risks(db)).find((r) => r.tokenMint === candidate.tokenMint) ??
            null,
          reason,
        );
        logger.warn(
          {
            mint: candidate.tokenMint,
            portfolioId: definition.id,
            status,
            reason,
          },
          'Free live market inputs unavailable; entry withheld',
        );
      }
    }
  }
  function schedule() {
    if (stopped || lease?.signal.aborted) return;
    running = poll()
      .catch(() => {
        status = 'ERROR';
        logger.error(
          { portfolioId: definition.id },
          'Free live paper decision processing failed',
        );
      })
      .finally(() => {
        if (!stopped && !lease?.signal.aborted)
          timer = setTimeout(schedule, config.FREE_MARKET_POLL_INTERVAL_MS);
      });
  }
  return {
    get status() {
      return status;
    },
    get portfolioId() {
      return definition.id;
    },
    async start() {
      if (started || stopped) return;
      started = true;
      status = 'STARTING';
      try {
        lease = await database.acquireForwardOwnership(definition.id);
        lease.signal.addEventListener(
          'abort',
          () => {
            status = 'ERROR';
            controller.abort();
            logger.error(
              { portfolioId: definition.id },
              'Free live paper account ownership lost; entry evaluation stopped',
            );
          },
          { once: true },
        );
        const db = lease.db;
        await createStrategyRepository(db).begin(profile.run);
        const existing = (
          await db
            .select({ definition: paperPortfolios.definition })
            .from(paperPortfolios)
            .where(eq(paperPortfolios.id, definition.id))
            .limit(1)
        )[0];
        if (existing)
          definition = paperAccountDefinitionSchema.parse(existing.definition);
        const repository = createPaperRepository(db);
        await repository.initialize(
          definition,
          initialPortfolio(definition),
          initialPosting(definition),
        );
        await repository.snapshot(definition.id, { readOnly: true });
        logger.info(
          {
            portfolioId: definition.id,
            status: 'LIVE_PAPER',
            source: 'GECKOTERMINAL_PUBLIC',
            executionModel: definition.freeExecution?.model ?? 'DECISIONS_ONLY',
          },
          'Free live paper-entry decisions started',
        );
        schedule();
      } catch (error) {
        status = 'ERROR';
        lease?.release();
        lease = undefined;
        throw error;
      }
    },
    async stop() {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      await running;
      lease?.release();
      lease = undefined;
      status = 'STOPPED';
    },
  };
}
