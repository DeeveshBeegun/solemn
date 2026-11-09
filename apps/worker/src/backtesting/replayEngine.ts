import {
  buyQuantity,
  latencyMs,
  prepareQuote,
} from '../execution/simulation/executionSimulator.js';
import { executionMark } from '../execution/simulation/mark.js';
import { fromAtomic, toAtomic } from '@solemn/shared';
import {
  analyzeHistory,
  paperAccountDefinitionSchema,
  stableHash,
  stableId,
  historicalEventSchema,
  historicalSortKey,
} from '@solemn/shared';
import type {
  BacktestPlan,
  BacktestResult,
  BuyCandidate,
  EquitySnapshot,
  ExecutionIntent,
  HistoricalEvent,
  HistoricalMarket,
  ExecutionObservation,
  PreparedQuote,
  ExecutionContext,
  MarketCandle,
  MarketCoverage,
  PaperCommand,
  PaperPortfolioState,
  PaperTransition,
  StrategyRiskContext,
  StrategyState,
} from '@solemn/shared';
import type {
  BacktestRepository,
  PaperRepository,
  StrategyRepository,
  StrategyRun,
} from '@solemn/database';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { CandleBuilder } from '../analysis/candleBuilder.js';
import {
  evaluateSignal,
  initialStrategyState,
} from '../strategy/signalEngine.js';
import { policyHash } from '../risk/tokenRiskEngine.js';
import {
  initialPortfolio,
  initialPosting,
} from '../portfolio/accountingService.js';
import { applyPaperCommand } from '../portfolio/portfolioManager.js';
import { chooseExit } from '../portfolio/positionManager.js';
import {
  executionPrice,
  observationProblem,
} from '../execution/paperExecutor.js';
import { recoverPortfolio } from '../portfolio/recovery.js';
import { SimulationClock } from './clock.js';
import { strategyConfigForBacktest } from './backtestConfig.js';
import { PerformanceAnalyzer } from './performanceAnalyzer.js';
import type { HistoricalDataProvider } from './historicalDataProvider.js';
export interface BacktestServices {
  paper: PaperRepository;
  strategy: StrategyRepository;
  backtests: BacktestRepository;
}
interface MarketState {
  market: HistoricalMarket;
  builder: CandleBuilder;
  coverage: MarketCoverage[];
  risk: StrategyRiskContext | null;
  candles: MarketCandle[];
  strategy: StrategyState;
  lastUpdate: string | null;
  lastDecisionAt: number;
}
interface PendingEntry {
  intent: ExecutionIntent;
  candidate: BuyCandidate;
}
const iso = (time: number) => new Date(time).toISOString();
const scope = (mint: string, pool: string) => `${mint}:${pool}`;
function newerRisk(
  next: StrategyRiskContext,
  previous: StrategyRiskContext | null,
) {
  if (!previous) return true;
  const requested = (risk: StrategyRiskContext) =>
    Date.parse(risk.assessment?.requestedAt ?? risk.availableAt);
  return (
    requested(next) > requested(previous) ||
    (requested(next) === requested(previous) &&
      ((next.assessment?.attempt ?? 0) > (previous.assessment?.attempt ?? 0) ||
        ((next.assessment?.attempt ?? 0) ===
          (previous.assessment?.attempt ?? 0) &&
          Date.parse(next.availableAt) >= Date.parse(previous.availableAt))))
  );
}
export async function runBacktest(
  plan: BacktestPlan,
  provider: HistoricalDataProvider,
  baseConfig: Config,
  services: BacktestServices,
  logger?: Logger,
  signal?: AbortSignal,
): Promise<BacktestResult> {
  if (
    provider.dataset.id !== plan.datasetId ||
    provider.dataset.fingerprint !== plan.datasetFingerprint
  )
    throw new Error('Backtest dataset identity mismatch');
  if (provider.dataset.quality.readiness === 'INSUFFICIENT')
    throw new Error(
      'Historical dataset is insufficient for strategy evaluation',
    );
  if (
    provider.dataset.manifest.markets.length >
    baseConfig.MARKET_DATA_MAX_TRACKED_TOKENS
  )
    throw new Error('Backtest exceeds maximum tracked markets');
  const cached = await services.backtests.start(plan);
  if (cached) {
    await recoverPortfolio(services.paper, plan.portfolioId);
    return cached;
  }
  const clock = new SimulationClock(plan.startTime),
    config = strategyConfigForBacktest(baseConfig, plan),
    analyzer = new PerformanceAnalyzer(plan);
  const run: StrategyRun = {
    id: plan.strategyRunId,
    mode: 'FIXTURE',
    strategyId: plan.strategy.strategyId,
    strategyVersion: plan.strategy.version,
    configHash: stableHash(plan.strategy),
    riskPolicyHash: policyHash(plan.risk),
    config: plan.strategy,
    datasetHash: plan.datasetFingerprint,
    dataset: null,
  };
  const definitionData = {
    policy: plan.paper,
    strategyPolicy: plan.strategy,
    riskPolicy: plan.risk,
    strategyRunId: run.id,
    replayHash: stableHash(plan),
  };
  const definition = paperAccountDefinitionSchema.parse({
    ...definitionData,
    id: plan.portfolioId,
    name: `backtest-${plan.runId}`,
    mode: 'PAPER',
    currency: 'USD',
    dataMode: 'FIXTURE',
    createdAt: plan.startTime,
    configHash: stableHash(definitionData),
  });
  let state: PaperPortfolioState = initialPortfolio(definition),
    eventsProcessed = 0,
    workUnits = 0;
  let material: boolean;
  let lastSnapshot: EquitySnapshot | undefined;
  const markets = new Map<string, MarketState>(
    provider.dataset.manifest.markets.map((market) => [
      scope(market.mint, market.poolAddress),
      {
        market,
        builder: new CandleBuilder(
          market.mint,
          market.poolAddress,
          market.quoteMint,
          plan.strategy.allowedLatenessMs,
        ),
        coverage: [],
        risk: null,
        candles: [],
        strategy: initialStrategyState(),
        lastUpdate: null,
        lastDecisionAt: Date.parse(plan.startTime) - 1,
      },
    ]),
  );
  const entries = new Map<string, PendingEntry>(),
    exits = new Map<string, ExecutionIntent>();
  const now = () => clock.now().toISOString();
  const latestPools = new Map<string, ExecutionObservation>();
  const prepared = new Map<string, PreparedQuote>();
  const attemptCounts = new Map<string, number>();
  const unavailablePools = new Set<string>();
  const captureQuote = (intent: ExecutionIntent) => {
    if (!plan.execution || prepared.has(intent.id)) return;
    const quoteAt = iso(
      Date.parse(intent.triggerAt) +
        plan.execution.latency.processingMs +
        plan.execution.latency.quoteMs,
    );
    if (now() < quoteAt) return;
    const observation = latestPools.get(scope(intent.mint, intent.poolAddress)),
      pool = observation?.pool ?? null;
    const position = state.positions.find((p) => p.id === intent.positionId);
    const allocation =
      (toAtomic(state.equityUsd) * toAtomic(plan.paper.maxPositionPercent)) /
      toAtomic('100');
    const budget = fromAtomic(
      allocation < toAtomic(state.availableCashUsd)
        ? allocation
        : toAtomic(state.availableCashUsd),
    );
    const quantity =
      intent.kind === 'ENTRY'
        ? buyQuantity(pool, budget, plan.execution, plan.paper.quantityDecimals)
        : (position?.pendingExitQuantity ?? position?.quantity);
    const quote = prepareQuote(
      pool,
      intent.kind === 'ENTRY' ? 'BUY' : 'SELL',
      quantity ?? '0.000000001',
      intent.triggerAt,
      quoteAt,
      intent.dueAt,
      plan.execution,
    );
    if (!quantity) quote.error = 'NO_EXECUTABLE_QUOTE_SIZE';
    prepared.set(intent.id, quote);
    logger?.debug(
      {
        runId: plan.runId,
        scenarioId: plan.execution.scenario,
        modelVersion: plan.execution.modelVersion,
        signalId: intent.signalId,
        mint: intent.mint,
        poolSnapshotId: pool?.id,
        quoteAt,
        error: quote.error,
      },
      'Historical pool quote generated',
    );
  };
  const executionContext = (
    intent: ExecutionIntent,
    observation: ExecutionObservation,
  ): ExecutionContext | undefined => {
    if (!plan.execution) return undefined;
    const quote = prepared.get(intent.id);
    if (!quote) throw new Error('Missing scheduled execution quote');
    return {
      runId: plan.runId,
      config: plan.execution,
      quote,
      pool: observation.pool ?? null,
      nativeUsd: observation.nativeUsd ?? null,
      randomKey: `${intent.mint}:${intent.kind}:${intent.triggerAt}`,
    };
  };
  const commit = async (command: PaperCommand): Promise<PaperTransition> => {
    const before = state,
      expected = applyPaperCommand(before, command, definition);
    const saved = await services.paper.transact(
      plan.portfolioId,
      command,
      (current, actualDefinition) => {
        if (
          stableHash(current) !== stableHash(before) ||
          stableHash(actualDefinition) !== stableHash(definition)
        )
          throw new Error(
            'Historical paper frontier differs from persisted state',
          );
        return expected;
      },
    );
    if (
      stableHash({
        orders: saved.orders,
        postings: saved.postings,
        result: saved.result,
      }) !==
      stableHash({
        orders: expected.orders,
        postings: expected.postings,
        result: expected.result,
      })
    )
      throw new Error('Historical paper command replay mismatch');
    // Historical reconstruction uses its own state, never a later mutable snapshot returned on a duplicate.
    state = expected.state;
    material = true;
    analyzer.transition(command, expected);
    for (const record of expected.orders)
      if (record.audit)
        logger?.debug(
          {
            runId: plan.runId,
            scenarioId: record.audit.context.config.scenario,
            orderId: record.order.id,
            attemptId: record.audit.id,
            mint: record.order.tokenMint,
            modelVersion: record.audit.modelVersion,
            quotePoolId: record.audit.context.quote.pool?.id,
            landingPoolId: record.audit.context.pool?.id,
            outcome: record.audit.outcome,
            reason: record.audit.reason,
            impactBps: record.audit.impactBps,
            fees: record.audit.fees,
          },
          'Paper execution attempt simulated',
        );
    logger?.debug(
      {
        runId: plan.runId,
        at: now(),
        outcome: expected.result.outcome,
        reasons: expected.result.reasons,
        orderId: expected.result.orderId,
      },
      'Backtest portfolio updated',
    );
    return expected;
  };
  const newIntent = (
    kind: 'ENTRY' | 'EXIT',
    mint: string,
    poolAddress: string,
    key: string,
    reason: string,
    signalId: string | null,
    positionId: string | null,
  ): ExecutionIntent => {
    const time = clock.now().getTime();
    return {
      id: stableId(['backtest-intent-v1', plan.runId, kind, key]),
      runId: plan.runId,
      kind,
      mint,
      poolAddress,
      signalId,
      positionId,
      triggerAt: now(),
      dueAt: iso(
        time +
          (plan.execution
            ? latencyMs(plan.execution)
            : plan.executionLatencyMs),
      ),
      expiresAt: iso(
        time +
          (plan.execution
            ? latencyMs(plan.execution)
            : plan.executionLatencyMs) +
          plan.executionWaitMs,
      ),
      reason,
      status: 'PENDING',
      attemptedAt: null,
      observationId: null,
      orderId: null,
      reasons: [],
    };
  };
  const scheduleExit = async (
    positionId: string,
    key: string,
    reason: string,
  ) => {
    const position = state.positions.find((item) => item.id === positionId)!;
    const old = exits.get(positionId);
    if (old && old.reason === reason) return;
    if (old) prepared.delete(old.id);
    if (old)
      await services.backtests.intent({
        ...old,
        status: 'SUPERSEDED',
        reasons: ['HIGHER_PRIORITY_EXIT_INTENT'],
      });
    const intent = newIntent(
      'EXIT',
      position.mint,
      position.poolAddress,
      key,
      reason,
      null,
      position.id,
    );
    exits.set(position.id, intent);
    captureQuote(intent);
    await services.backtests.intent(intent);
  };
  try {
    const rangeManifest = {
      ...provider.dataset.manifest,
      startTime: plan.startTime,
      endTime: plan.endTime,
    };
    const runQuality = await analyzeHistory(
      rangeManifest,
      provider.getEvents({
        startTime: plan.startTime,
        endTime: plan.endTime,
        batchSize: plan.batchSize,
      }),
    );
    if (runQuality.quality.totalEvents > plan.maxEvents)
      throw new Error('Selected history exceeds maximum event count');
    await services.strategy.begin(run);
    await services.paper.initialize(
      definition,
      state,
      initialPosting(definition),
    );
    await services.backtests.attach(plan);
    await recoverPortfolio(services.paper, plan.portfolioId);
    const eventStream = provider.getEvents({
      startTime: plan.startTime,
      endTime: plan.endTime,
      batchSize: plan.batchSize,
    });
    const iterator = eventStream[Symbol.asyncIterator]();
    let priorKey = '',
      priorHash = '';
    const nextEvent = async (): Promise<HistoricalEvent | null> => {
      for (;;) {
        const item = await iterator.next();
        if (item.done) return null;
        const event = historicalEventSchema.parse(item.value),
          key = historicalSortKey(event),
          hash = stableHash(event);
        if (key < priorKey)
          throw new Error(
            'Historical provider violated chronological ordering',
          );
        if (key === priorKey) {
          if (hash !== priorHash)
            throw new Error('Conflicting replay duplicate');
          continue;
        }
        priorKey = key;
        priorHash = hash;
        if (++eventsProcessed > plan.maxEvents || ++workUnits > plan.maxEvents)
          throw new Error('Backtest exceeds maximum event count');
        return event;
      }
    };
    let upcoming = await nextEvent(),
      nextCandle =
        Date.parse(plan.startTime) + 60000 + plan.strategy.allowedLatenessMs,
      nextCadence = Date.parse(plan.startTime);
    const end = Date.parse(plan.endTime);
    logger?.info(
      {
        runId: plan.runId,
        datasetId: plan.datasetId,
        sourceKind: plan.sourceKind,
      },
      'Historical backtest started',
    );
    for (;;) {
      if (signal?.aborted) throw new Error('Backtest cancelled');
      const expiration = Math.min(
        ...[...entries.values()].map((entry) =>
          Date.parse(entry.intent.expiresAt),
        ),
        ...[...exits.values()].map((intent) => Date.parse(intent.expiresAt)),
        Infinity,
      );
      const quoteTimer = plan.execution
        ? Math.min(
            ...[...entries.values()]
              .map((e) => e.intent)
              .concat([...exits.values()])
              .filter((i) => !prepared.has(i.id))
              .map(
                (i) =>
                  Date.parse(i.triggerAt) +
                  plan.execution!.latency.processingMs +
                  plan.execution!.latency.quoteMs,
              ),
            Infinity,
          )
        : Infinity;
      const time = Math.min(
        quoteTimer,
        upcoming ? Date.parse(upcoming.availableAt) : Infinity,
        nextCandle,
        nextCadence,
        expiration,
        end,
      );
      if (++workUnits > plan.maxEvents)
        throw new Error('Backtest replay work budget exceeded');
      clock.advance(time);
      material = false;
      const quotes: Extract<HistoricalEvent, { kind: 'EXECUTION' }>[] = [];
      let cohort = 0;
      while (upcoming && Date.parse(upcoming.availableAt) === time) {
        if (++cohort > plan.batchSize)
          throw new Error(
            'Historical same-time cohort exceeds the configured batch capacity',
          );
        const event = upcoming,
          context = markets.get(scope(event.mint, event.poolAddress));
        if (!context) throw new Error('Unknown replay pool');
        if (event.kind === 'TRADE') {
          context.builder.ingest(event.data);
          context.lastUpdate = event.availableAt;
        }
        if (event.kind === 'COVERAGE') {
          context.coverage.push(event.data);
          context.lastUpdate = event.availableAt;
          if (context.coverage.length > 1000)
            throw new Error('Historical coverage window capacity exceeded');
        }
        if (event.kind === 'RISK' && newerRisk(event.data, context.risk))
          context.risk = event.data;
        if (event.kind === 'EXECUTION') {
          quotes.push(event);
          const old = latestPools.get(scope(event.mint, event.poolAddress));
          if (
            event.data.pool &&
            (!old?.pool || event.data.pool.observedAt >= old.pool.observedAt)
          )
            latestPools.set(scope(event.mint, event.poolAddress), event.data);
        }
        logger?.debug(
          {
            runId: plan.runId,
            eventId: event.id,
            kind: event.kind,
            availableAt: event.availableAt,
          },
          'Historical market event processed',
        );
        upcoming = await nextEvent();
      }
      // Technical ID order never resolves conflicting same-time quotes with unknown source order.
      const ambiguous = new Set<string>();
      const groups = new Map<
        string,
        { value: string; completeOrder: boolean }
      >();
      for (const event of quotes) {
        const key = `${event.mint}:${event.poolAddress}:${event.data.side}:${event.eventAt}`,
          value = stableHash([
            event.data.priceUsd,
            event.data.liquidityUsd,
            event.data.estimatedPriceImpactPercent,
            ...(plan.execution
              ? [
                  event.data.pool ? { ...event.data.pool, id: null } : null,
                  event.data.nativeUsd ?? null,
                ]
              : []),
          ]);
        const previous = groups.get(key),
          completeOrder =
            event.slot !== null && event.transactionIndex !== null;
        if (
          previous &&
          previous.value !== value &&
          (!previous.completeOrder || !completeOrder)
        )
          ambiguous.add(key);
        groups.set(key, { value, completeOrder });
      }
      for (const event of quotes)
        if (
          ambiguous.has(
            `${event.mint}:${event.poolAddress}:${event.data.side}:${event.eventAt}`,
          )
        )
          latestPools.delete(scope(event.mint, event.poolAddress));
      if (time === nextCandle) {
        const candleEnd = time - plan.strategy.allowedLatenessMs;
        for (const context of markets.values()) {
          if (++workUnits > plan.maxEvents)
            throw new Error('Backtest replay work budget exceeded');
          const market = context.market,
            candle = context.builder.build(
              iso(candleEnd - 60000),
              now(),
              context.coverage,
            );
          context.candles.push(candle);
          if (context.candles.length > 16) context.candles.shift();
          const corrections = context.builder.visibleCorrections(now());
          const decision = evaluateSignal(
            {
              runId: run.id,
              mint: market.mint,
              poolAddress: market.poolAddress,
              poolCreatedAt:
                market.poolCreatedAt &&
                market.poolCreationAvailableAt &&
                Date.parse(market.poolCreationAvailableAt) <= time
                  ? market.poolCreatedAt
                  : null,
              asOf: now(),
              candleEnd: iso(candleEnd),
              candles: context.candles,
              risk: context.risk,
              feedHealthy:
                candle.complete &&
                !context.coverage.some(
                  (coverage) =>
                    coverage.kind === 'GAP' &&
                    Date.parse(coverage.end) > candleEnd - 10 * 60000 &&
                    Date.parse(coverage.start) < candleEnd,
                ),
              lastMarketUpdateAt: context.lastUpdate,
              corrections,
              sourceRefs: [
                ...context.candles.map((item) => item.id),
                ...context.candles.flatMap((item) => item.tradeIds),
                ...context.coverage.map((item) => item.id),
                ...(context.risk?.assessment
                  ? [context.risk.assessment.id]
                  : []),
                ...corrections.map((item) => item.id),
              ],
            },
            context.strategy,
            config,
          );
          await services.strategy.save(
            run,
            decision,
            [candle],
            corrections.filter(
              (correction) =>
                Date.parse(correction.receivedAt) > context.lastDecisionAt,
            ),
          );
          context.strategy = decision.stateAfter;
          context.lastDecisionAt = time;
          analyzer.decision(decision);
          if (decision.candidate) {
            const candidate = decision.candidate,
              intent = newIntent(
                'ENTRY',
                candidate.mint,
                candidate.poolAddress,
                candidate.id,
                'BUY_CANDIDATE',
                candidate.id,
                null,
              );
            if (entries.size >= baseConfig.MARKET_DATA_MAX_TRACKED_TOKENS * 2)
              throw new Error('Backtest pending entry capacity exceeded');
            entries.set(candidate.id, { candidate, intent });
            captureQuote(intent);
            await services.backtests.intent(intent);
            logger?.info(
              {
                runId: plan.runId,
                signalId: candidate.id,
                at: now(),
                dueAt: intent.dueAt,
              },
              'Historical trading signal generated',
            );
          }
          const cutoff = candleEnd - 17 * 60000;
          context.builder.prune(iso(cutoff));
          context.coverage = context.coverage.filter(
            (coverage) => Date.parse(coverage.end) >= cutoff,
          );
        }
        nextCandle += 60000;
      }
      for (const entry of entries.values()) captureQuote(entry.intent);
      for (const intent of exits.values()) captureQuote(intent);
      for (const event of quotes) {
        const context = markets.get(scope(event.mint, event.poolAddress))!,
          raw = event.data;
        const observation = ambiguous.has(
          `${event.mint}:${event.poolAddress}:${raw.side}:${event.eventAt}`,
        )
          ? { ...raw, healthy: false }
          : raw;
        if (raw.side === 'BUY') {
          for (const [key, pending] of entries) {
            const intent = pending.intent;
            if (
              intent.mint !== event.mint ||
              intent.poolAddress !== event.poolAddress ||
              time < Date.parse(intent.dueAt) ||
              time > Date.parse(intent.expiresAt) ||
              time <= Date.parse(intent.triggerAt) ||
              Date.parse(observation.observedAt) < Date.parse(intent.dueAt)
            )
              continue;
            if (
              observationProblem(
                observation,
                plan.paper,
                now(),
                event.mint,
                event.poolAddress,
                'BUY',
              )
            ) {
              analyzer.unavailable++;
              continue;
            }
            const command: PaperCommand = {
              type: 'ENTRY',
              id: stableId([
                'paper-entry-v1',
                plan.portfolioId,
                pending.candidate.id,
              ]),
              at: now(),
              candidate: pending.candidate,
              risk: context.risk,
              observation,
              ...(plan.execution
                ? { execution: executionContext(intent, observation)! }
                : {}),
            };
            const transition = await commit(command);
            await services.backtests.intent({
              ...intent,
              status:
                transition.result.outcome === 'ENTRY_FILLED'
                  ? 'FILLED'
                  : 'FAILED',
              attemptedAt: now(),
              observationId: event.id,
              orderId: transition.result.orderId,
              reasons: transition.result.reasons,
            });
            entries.delete(key);
            prepared.delete(intent.id);
          }
        } else {
          const position = state.positions.find(
            (item) =>
              item.mint === event.mint &&
              item.poolAddress === event.poolAddress &&
              item.status !== 'CLOSED',
          );
          if (!position) continue;
          // A newly executable route starts a fresh bounded retry window after a documented outage.
          if (plan.execution) {
            const executable =
              executionMark(observation, position.quantity, plan.execution) !==
              null;
            if (!executable) unavailablePools.add(position.id);
            else if (unavailablePools.delete(position.id))
              attemptCounts.set(position.id, 0);
          }
          const pending = exits.get(position.id),
            price = plan.execution
              ? (executionMark(observation, position.quantity, plan.execution)
                  ?.priceUsd ?? observation.priceUsd)
              : executionPrice(observation, plan.paper),
            problem = observationProblem(
              observation,
              plan.paper,
              now(),
              event.mint,
              event.poolAddress,
              'SELL',
            );
          const critical =
            context.risk?.currentStatus === 'REJECTED' &&
            context.risk.assessment?.tokenMint === position.mint;
          const predicted =
            !problem && price
              ? chooseExit(position, price, now(), plan.paper, critical)
              : null;
          const canExecute =
            !!pending &&
            !state.executionUncertain &&
            (attemptCounts.get(position.id) ?? 0) <
              (plan.execution?.maxAttemptsPerPosition ??
                Number.MAX_SAFE_INTEGER) &&
            !problem &&
            predicted?.reason === pending.reason &&
            time >= Date.parse(pending.dueAt) &&
            time <= Date.parse(pending.expiresAt) &&
            time > Date.parse(pending.triggerAt) &&
            Date.parse(observation.observedAt) >= Date.parse(pending.dueAt);
          const command: PaperCommand = {
            type: 'MARK',
            id: stableId(['paper-mark-v1', plan.portfolioId, observation.id]),
            at: now(),
            observation,
            risk: context.risk,
            deferExecution: !canExecute,
            ...(plan.execution
              ? {
                  execution:
                    canExecute && pending
                      ? executionContext(pending, observation)!
                      : {
                          runId: plan.runId,
                          config: plan.execution,
                          quote: prepareQuote(
                            observation.pool ?? null,
                            'SELL',
                            position.quantity,
                            now(),
                            now(),
                            now(),
                            plan.execution,
                          ),
                          pool: observation.pool ?? null,
                          nativeUsd: observation.nativeUsd ?? null,
                          randomKey: `mark:${event.id}`,
                        },
                }
              : {}),
          };
          const transition = await commit(command);
          if (transition.result.outcome === 'EXIT_SCHEDULED')
            await scheduleExit(
              position.id,
              event.id,
              transition.result.reasons[0]!,
            );
          if (
            canExecute &&
            pending &&
            (transition.result.outcome === 'EXIT_FILLED' ||
              transition.orders.length > 0)
          ) {
            await services.backtests.intent({
              ...pending,
              status:
                transition.result.outcome === 'EXIT_FILLED'
                  ? 'FILLED'
                  : 'FAILED',
              attemptedAt: now(),
              observationId: event.id,
              orderId: transition.result.orderId,
              reasons: transition.result.reasons,
            });
            exits.delete(position.id);
            prepared.delete(pending.id);
            attemptCounts.set(
              position.id,
              (attemptCounts.get(position.id) ?? 0) + 1,
            );
            const remaining = state.positions.find(
              (item) => item.id === position.id,
            )!;
            if (
              remaining.status !== 'CLOSED' &&
              remaining.pendingExitReason &&
              !state.executionUncertain &&
              (attemptCounts.get(position.id) ?? 0) <
                (plan.execution?.maxAttemptsPerPosition ??
                  Number.MAX_SAFE_INTEGER)
            )
              await scheduleExit(
                position.id,
                `retry:${event.id}`,
                remaining.pendingExitReason,
              );
          }
        }
      }
      for (const [key, pending] of entries)
        if (time >= Date.parse(pending.intent.expiresAt)) {
          const context = markets.get(
            scope(pending.intent.mint, pending.intent.poolAddress),
          )!;
          await commit({
            type: 'ENTRY',
            id: stableId([
              'paper-entry-v1',
              plan.portfolioId,
              pending.candidate.id,
            ]),
            at: now(),
            candidate: pending.candidate,
            risk: context.risk,
            observation: null,
          });
          await services.backtests.intent({
            ...pending.intent,
            status: 'EXPIRED',
            attemptedAt: now(),
            reasons: ['NO_VALID_EXECUTION_OBSERVATION'],
          });
          entries.delete(key);
          prepared.delete(pending.intent.id);
          analyzer.missingExecution++;
          analyzer.unavailable++;
        }
      for (const [key, intent] of exits)
        if (time >= Date.parse(intent.expiresAt)) {
          await commit({
            type: 'EXIT_UNAVAILABLE',
            id: stableId(['backtest-exit-unavailable', intent.id]),
            at: now(),
            positionId: key,
            reason: 'NO_VALID_EXECUTION_OBSERVATION',
          });
          await services.backtests.intent({
            ...intent,
            status: 'EXPIRED',
            attemptedAt: now(),
            reasons: ['NO_VALID_EXECUTION_OBSERVATION'],
          });
          exits.delete(key);
          prepared.delete(intent.id);
          analyzer.unavailable++;
        }
      const cadence = time === nextCadence;
      if (cadence || time === end) {
        await commit({
          type: 'TICK',
          id: stableId(['backtest-tick-v1', plan.portfolioId, now()]),
          at: now(),
        });
        if (cadence) nextCadence += plan.equityCadenceMs;
      }
      if (material || cadence || time === end) {
        lastSnapshot = analyzer.snapshot(state, now());
        await services.backtests.equity(lastSnapshot);
      }
      if (time === end) break;
    }
    for (const entry of entries.values()) {
      await services.backtests.intent({
        ...entry.intent,
        status: 'UNFILLED',
        reasons: ['REPLAY_ENDED_BEFORE_VALID_EXECUTION'],
      });
      analyzer.missingExecution++;
      analyzer.unavailable++;
    }
    for (const intent of exits.values()) {
      await services.backtests.intent({
        ...intent,
        status: 'UNFILLED',
        reasons: ['REPLAY_ENDED_BEFORE_VALID_EXECUTION'],
      });
      analyzer.unavailable++;
    }
    const recovered = await recoverPortfolio(services.paper, plan.portfolioId);
    if (stableHash(recovered.state) !== stableHash(state))
      throw new Error('Historical final accounting reconciliation failed');
    const result: BacktestResult = {
      plan,
      dataset: provider.dataset,
      runDataQuality: runQuality.quality,
      metrics: analyzer.finish(state, lastSnapshot!, {
        ...provider.dataset,
        quality: runQuality.quality,
      }),
      finalState: state,
      eventsProcessed,
      signals: analyzer.signals,
      limitations: [
        ...provider.dataset.quality.limitations,
        ...(plan.execution
          ? [
              'Reference CPMM, latency and failure parameters are research assumptions, not verified venue fills.',
              'Historical pool observations reset the counterfactual reserve anchor; simulated fills do not modify the exogenous market tape.',
              'Nonzero recoverable rent is explicitly unsupported; no rent is charged as a trading fee.',
              'Current operational history has no verified pool reserves. Fixture results are synthetic.',
            ]
          : [
              'Percentage fees/slippage and execution latency are research assumptions, not verified Solana execution costs.',
              'No pool-depth, priority-fee, network failure-fee or survivorship correction model is implemented.',
            ]),
        'Unknown open-position valuations remain null; maximum drawdown over reliable snapshots can understate the full-period drawdown.',
      ],
    };
    await services.backtests.complete(result);
    logger?.info(
      { runId: plan.runId, metrics: result.metrics.portfolio },
      'Backtest completed',
    );
    return result;
  } catch (error) {
    await services.backtests.fail(plan.runId, signal?.aborted ?? false);
    throw error;
  }
}
