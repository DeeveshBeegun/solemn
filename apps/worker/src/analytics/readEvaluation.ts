import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import {
  backtestDatasetEvents,
  backtestDatasets,
  backtestEquitySnapshots,
  backtestExecutionIntents,
  backtestResults,
  backtestRuns,
  createPaperRepository,
  forwardAccounts,
  forwardRuntimeEvents,
  paperPortfolios,
  strategyDecisions,
  strategyEvaluationPeriods,
  strategyRuns,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import {
  backtestPlanSchema,
  stableHash,
  strategyDecisionSchema,
} from '@solemn/shared';
import type {
  CapturedPortfolio,
  AttributionEvent,
  EquityPoint,
  Selection,
  Source,
  SourceObservations,
} from './contracts.js';
import { inPeriod, iso } from './contracts.js';
import { recoverPortfolio } from '../portfolio/recovery.js';

const limit = 100000;
const sourceExpression = sql<Source>`case
  when ${forwardAccounts.mode}='REPLAY' then 'forward-replay'
  when ${forwardAccounts.mode}='LIVE_READ_ONLY' then 'forward'
  when ${backtestDatasets.manifest}->>'sourceKind'='SYNTHETIC' then 'synthetic'
  when ${backtestDatasets.manifest}->>'sourceKind'='HISTORICAL' then 'historical'
  else 'paper-replay' end`;
const collect = (values: Iterable<string>) => [...new Set(values)].sort();
function bounded<T>(rows: T[]): T[] {
  if (rows.length > limit)
    throw new Error('Evaluation input exceeds local analysis capacity');
  return rows;
}
const countOrNull = (array: unknown[] | null) =>
  array === null ? null : array.length;
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string')
    : [];

export async function selectPortfolio(db: Database, selection: Selection) {
  const [row] = await db
    .select({
      portfolioId: paperPortfolios.id,
      definition: paperPortfolios.definition,
      strategy: strategyRuns,
      source: sourceExpression,
      run: backtestRuns,
      result: backtestResults.payload,
      dataset: backtestDatasets,
      forward: forwardAccounts,
    })
    .from(paperPortfolios)
    .innerJoin(strategyRuns, eq(strategyRuns.id, paperPortfolios.strategyRunId))
    .leftJoin(backtestRuns, eq(backtestRuns.portfolioId, paperPortfolios.id))
    .leftJoin(backtestResults, eq(backtestResults.runId, backtestRuns.id))
    .leftJoin(backtestDatasets, eq(backtestDatasets.id, backtestRuns.datasetId))
    .leftJoin(
      forwardAccounts,
      eq(forwardAccounts.portfolioId, paperPortfolios.id),
    )
    .where(
      and(
        eq(strategyRuns.strategyId, selection.strategyId),
        selection.portfolioId
          ? eq(paperPortfolios.id, selection.portfolioId)
          : undefined,
        selection.source
          ? sql`${sourceExpression} = ${selection.source}`
          : undefined,
        sql`(${backtestRuns.id} is null or ${backtestRuns.status}='COMPLETED')`,
        sql`(${paperPortfolios.dataMode}='FIXTURE' or ${forwardAccounts.portfolioId} is not null)`,
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${backtestRuns.completedAt},${forwardAccounts.heartbeatAt},${paperPortfolios.updatedAt})`,
      ),
      asc(paperPortfolios.id),
    )
    .limit(1);
  return row;
}

export function verifyConfiguration(
  row: NonNullable<Awaited<ReturnType<typeof selectPortfolio>>>,
) {
  const definition = row.definition,
    strategy = row.strategy;
  const definitionHash = stableHash({
    policy: definition.policy,
    strategyPolicy: definition.strategyPolicy,
    riskPolicy: definition.riskPolicy,
    strategyRunId: definition.strategyRunId,
    replayHash: definition.replayHash,
    ...(definition.forwardExecution
      ? { forwardExecution: definition.forwardExecution }
      : {}),
  });
  const plan = row.run ? backtestPlanSchema.parse(row.run.plan) : null;
  if (
    definition.configHash !== definitionHash ||
    strategy.strategyId !== definition.strategyPolicy.strategyId ||
    strategy.strategyVersion !== definition.strategyPolicy.version ||
    strategy.configHash !== stableHash(definition.strategyPolicy) ||
    strategy.configHash !== stableHash(strategy.config) ||
    strategy.riskPolicyHash !== stableHash(definition.riskPolicy)
  )
    throw new Error(
      'Stored strategy or portfolio configuration does not reconcile',
    );
  if (
    plan &&
    (!row.result ||
      !row.dataset ||
      stableHash(plan) !== row.run!.configHash ||
      stableHash(row.result.plan) !== row.run!.configHash ||
      definition.replayHash !== row.run!.configHash ||
      row.dataset.fingerprint !== plan.datasetFingerprint ||
      row.run!.datasetFingerprint !== plan.datasetFingerprint ||
      plan.strategyRunId !== strategy.id ||
      plan.portfolioId !== row.portfolioId)
  )
    throw new Error('Stored backtest configuration does not reconcile');
  if (
    row.forward &&
    (row.forward.profileHash !== definition.replayHash ||
      (row.forward.mode === 'REPLAY' ? 'FORWARD_REPLAY' : 'FORWARD_LIVE') !==
        definition.dataMode)
  )
    throw new Error('Stored forward profile does not reconcile');
  const execution = plan?.execution ?? definition.forwardExecution ?? null;
  const configurationHash = stableHash({
    strategy: definition.strategyPolicy,
    risk: definition.riskPolicy,
    paper: definition.policy,
    execution,
    executionTiming: plan
      ? { latencyMs: plan.executionLatencyMs, waitMs: plan.executionWaitMs }
      : null,
  });
  return { execution, configurationHash, plan };
}

export async function readEvaluation(
  db: Database,
  selection: Selection,
): Promise<CapturedPortfolio | null> {
  return db.transaction(
    async (tx) => {
      const registration = selection.periodId
        ? (
            await tx
              .select()
              .from(strategyEvaluationPeriods)
              .where(eq(strategyEvaluationPeriods.id, selection.periodId))
          )[0]
        : undefined;
      if (selection.periodId && !registration)
        throw new Error('Unknown registered period');
      if (
        registration &&
        ((selection.portfolioId &&
          selection.portfolioId !== registration.portfolioId) ||
          (selection.source && selection.source !== registration.source) ||
          selection.start ||
          selection.end ||
          (selection.type && selection.type !== registration.kind))
      )
        throw new Error(
          'Registered period determines portfolio, source, type and dates',
        );
      const row = await selectPortfolio(
        tx,
        registration
          ? {
              strategyId: selection.strategyId,
              portfolioId: registration.portfolioId,
            }
          : selection,
      );
      if (!row) {
        if (selection.portfolioId || registration)
          throw new Error(
            'Portfolio does not match the selected strategy and source',
          );
        return null;
      }
      const { execution, configurationHash, plan } = verifyConfiguration(row);
      if (
        registration &&
        (registration.configurationHash !== configurationHash ||
          registration.source !== row.source ||
          registration.strategyVersion !== row.strategy.strategyVersion ||
          registration.strategyId !== row.strategy.strategyId)
      )
        throw new Error('Registered strategy, configuration or source changed');
      const periodType =
        registration?.kind ??
        selection.type ??
        (row.source === 'forward' ? 'FORWARD' : 'DEVELOPMENT');
      if (periodType === 'HOLDOUT' && !registration)
        throw new Error('Untouched holdout requires prospective registration');
      if (periodType === 'FORWARD' && row.source !== 'forward')
        throw new Error('FORWARD period requires the genuine forward source');
      const repository = createPaperRepository(tx),
        snapshot = await repository.snapshot(row.portfolioId, {
          readOnly: true,
          maxEvents: limit,
        });
      if (snapshot.events.length > limit)
        throw new Error('Ledger exceeds local analysis capacity');
      await recoverPortfolio(repository, row.portfolioId, snapshot);
      if (
        row.result &&
        plan &&
        stableHash(row.result.finalState) !==
          stableHash(
            snapshot.events
              .filter(
                (e) => Date.parse(e.timestamp) <= Date.parse(plan.endTime),
              )
              .at(-1)?.stateAfter ?? null,
          )
      )
        throw new Error(
          'Stored backtest result differs from the reconciled portfolio cutoff',
        );
      const availableStart = iso(
          plan?.startTime ?? snapshot.definition.createdAt,
        ),
        availableEnd = iso(
          plan?.endTime ??
            (row.source === 'forward' && row.forward
              ? row.forward.heartbeatAt
              : snapshot.state.asOf),
        );
      const start = iso(
          registration?.startAt ?? selection.start ?? availableStart,
        ),
        end = iso(registration?.endAt ?? selection.end ?? availableEnd);
      if (
        start < availableStart ||
        end > availableEnd ||
        start > end ||
        ((selection.start || selection.end || registration) && start === end)
      )
        throw new Error(
          'Evaluation period must lie within the stored source range',
        );
      if (registration && Date.parse(end) > Date.now())
        throw new Error('Registered period has not ended');
      const sealed = await tx
        .select({ id: strategyEvaluationPeriods.id })
        .from(strategyEvaluationPeriods)
        .where(
          and(
            eq(strategyEvaluationPeriods.strategyId, row.strategy.strategyId),
            eq(strategyEvaluationPeriods.kind, 'HOLDOUT'),
            lte(strategyEvaluationPeriods.startAt, end),
            gte(strategyEvaluationPeriods.endAt, start),
            registration
              ? ne(strategyEvaluationPeriods.id, registration.id)
              : undefined,
          ),
        )
        .limit(1);
      if (sealed.length)
        throw new Error('Evaluation overlaps a sealed holdout period');
      const prefix = snapshot.events.filter(
        (e) => Date.parse(e.timestamp) <= Date.parse(end),
      );
      const startState =
        prefix.filter((e) => Date.parse(e.timestamp) < Date.parse(start)).at(-1)
          ?.stateAfter ?? snapshot.events[0]!.stateAfter;
      const endState = prefix.at(-1)?.stateAfter;
      if (!endState)
        throw new Error('Evaluation ends before portfolio initialization');
      const journal = prefix.filter((e) => inPeriod(e.timestamp, start, end));
      const decisions = bounded(
        await tx
          .select({ payload: strategyDecisions.payload })
          .from(strategyDecisions)
          .where(
            and(
              eq(strategyDecisions.runId, row.strategy.id),
              lte(strategyDecisions.timestamp, end),
            ),
          )
          .orderBy(asc(strategyDecisions.timestamp), asc(strategyDecisions.id))
          .limit(limit + 1),
      ).map((r) => strategyDecisionSchema.parse(r.payload));
      const windowDecisions = decisions.filter((d) =>
        inPeriod(d.timestamp, start, end),
      );
      const equity: EquityPoint[] = [],
        intents: AttributionEvent[] = [];
      let sourceReferences: unknown[] = [];
      const observations: SourceObservations = {
        discovered: null,
        analyzed: collect(
          windowDecisions.filter((d) => d.risk?.assessment).map((d) => d.mint),
        ),
        eligible: collect(
          windowDecisions
            .filter(
              (d) =>
                d.risk?.assessment?.status === 'ELIGIBLE' &&
                d.risk.currentStatus === 'ELIGIBLE' &&
                d.risk.currentRequestId === d.risk.assessment.requestId &&
                d.risk.assessment.validUntil &&
                Date.parse(d.risk.assessment.validUntil) >
                  Date.parse(d.timestamp),
            )
            .map((d) => d.mint),
        ),
        watched: null,
        marketGaps: null,
        downtimeMs: null,
        observationCount: null,
        rawTradeCount: null,
        missingPrice: null,
        missingLiquidity: null,
        missingRisk: windowDecisions.filter(
          (d) => !d.risk?.assessment || d.risk.currentStatus === 'UNKNOWN',
        ).length,
        duplicates: null,
        rejected: null,
        observedRuntimeMs: null,
      };
      if (row.run && row.dataset) {
        const runId = row.run.id;
        const points = bounded(
          await tx
            .select({
              at: backtestEquitySnapshots.timestamp,
              equityUsd: backtestEquitySnapshots.totalEquityUsd,
              payload: backtestEquitySnapshots.payload,
            })
            .from(backtestEquitySnapshots)
            .where(
              and(
                eq(backtestEquitySnapshots.runId, runId),
                gte(backtestEquitySnapshots.timestamp, start),
                lte(backtestEquitySnapshots.timestamp, end),
              ),
            )
            .orderBy(asc(backtestEquitySnapshots.timestamp))
            .limit(limit + 1),
        );
        equity.push(
          ...points.map((p) => ({
            at: iso(p.at),
            equityUsd: p.equityUsd,
            reason: p.payload.reasons.join('|') || null,
          })),
        );
        const rows = bounded(
          await tx
            .select({ payload: backtestExecutionIntents.payload })
            .from(backtestExecutionIntents)
            .where(
              and(
                eq(backtestExecutionIntents.runId, runId),
                lte(backtestExecutionIntents.dueAt, end),
              ),
            )
            .orderBy(asc(backtestExecutionIntents.id))
            .limit(limit + 1),
        );
        for (const { payload: i } of rows)
          if (i.kind === 'ENTRY' && i.signalId) {
            const at =
              i.attemptedAt ?? (i.status === 'UNFILLED' ? plan!.endTime : null);
            if (at && Date.parse(at) <= Date.parse(end))
              intents.push({
                signalId: i.signalId,
                at,
                status: i.status,
                reasons: i.reasons,
                orderId: i.orderId,
              });
          }
        const input = bounded(
          await tx
            .select({
              payload: backtestDatasetEvents.payload,
              hash: backtestDatasetEvents.payloadHash,
            })
            .from(backtestDatasetEvents)
            .where(
              and(
                eq(backtestDatasetEvents.datasetId, row.dataset.id),
                gte(backtestDatasetEvents.availableAt, start),
                lte(backtestDatasetEvents.availableAt, end),
              ),
            )
            .orderBy(asc(backtestDatasetEvents.sortKey))
            .limit(limit + 1),
        );
        const events = input.map((r) => r.payload),
          coverage = events.filter(
            (e) => e.kind === 'COVERAGE' && e.data.kind === 'GAP',
          );
        observations.discovered = collect(
          events.filter((e) => e.kind === 'DISCOVERY').map((e) => e.mint),
        );
        observations.analyzed = collect(
          events
            .filter((e) => e.kind === 'RISK' && e.data.assessment)
            .map((e) => e.mint),
        );
        observations.eligible = collect(
          events
            .filter(
              (e) =>
                e.kind === 'RISK' &&
                e.data.currentStatus === 'ELIGIBLE' &&
                e.data.assessment?.status === 'ELIGIBLE' &&
                e.data.currentRequestId === e.data.assessment.requestId &&
                e.data.assessment.validUntil &&
                Date.parse(e.data.assessment.validUntil) >
                  Date.parse(e.availableAt),
            )
            .map((e) => e.mint),
        );
        observations.marketGaps = coverage.length;
        observations.downtimeMs = null; // Market-specific gaps can overlap and are not provider outages.
        observations.observationCount = events.length;
        observations.rawTradeCount = events.filter(
          (e) => e.kind === 'TRADE',
        ).length;
        observations.missingPrice = events.filter(
          (e) =>
            (e.kind === 'TRADE' || e.kind === 'EXECUTION') &&
            (e.data.priceUsd === null || !e.data.usdReliable),
        ).length;
        observations.missingLiquidity = events.filter(
          (e) => e.kind === 'EXECUTION' && e.data.liquidityUsd === null,
        ).length;
        observations.missingRisk = events.filter(
          (e) =>
            e.kind === 'RISK' &&
            (!e.data.assessment || e.data.currentStatus === 'UNKNOWN'),
        ).length;
        if (start === availableStart && end === availableEnd)
          observations.duplicates =
            row.result?.runDataQuality.duplicateEvents ?? null;
        sourceReferences = input.map((r) => r.hash);
      } else if (row.forward) {
        const runtime = bounded(
          await tx
            .select()
            .from(forwardRuntimeEvents)
            .where(
              and(
                eq(forwardRuntimeEvents.portfolioId, row.portfolioId),
                lte(forwardRuntimeEvents.at, end),
                sql`${forwardRuntimeEvents.kind} not in ('SESSION_STARTED','SESSION_ENDED')`,
              ),
            )
            .orderBy(asc(forwardRuntimeEvents.at), asc(forwardRuntimeEvents.id))
            .limit(limit + 1),
        );
        const window = runtime.filter((e) => inPeriod(e.at, start, end));
        const discoveries = window.filter(
          (e) =>
            e.kind === 'FIXTURE_DISCOVERY' &&
            typeof e.details.mint === 'string',
        );
        observations.discovered =
          row.source === 'forward-replay'
            ? collect(discoveries.map((e) => String(e.details.mint)))
            : null;
        const watched = new Set<string>(),
          observed = new Set<string>();
        for (const r of runtime)
          if (
            (r.kind === 'WATCH_ADDED' || r.kind === 'WATCH_REMOVED') &&
            typeof r.details.key === 'string'
          ) {
            if (r.kind === 'WATCH_ADDED') watched.add(r.details.key);
            else watched.delete(r.details.key);
            if (Date.parse(r.at) >= Date.parse(start))
              for (const key of watched) observed.add(key.split(':')[0]!);
          }
        for (const key of watched) observed.add(key.split(':')[0]!);
        observations.watched =
          row.source === 'forward-replay' ? collect(observed) : null;
        const gaps = runtime.filter((e) => e.kind === 'GAP_STARTED'),
          closes = new Map(
            runtime
              .filter((e) => e.kind === 'GAP_ENDED')
              .map((e) => [String(e.details.id ?? e.details.start), e.at]),
          );
        const intervals = gaps
          .map(
            (g) =>
              [
                Math.max(Date.parse(start), Date.parse(g.at)),
                Math.min(
                  Date.parse(end),
                  Date.parse(
                    closes.get(String(g.details.id ?? g.details.start)) ?? end,
                  ),
                ),
              ] as const,
          )
          .filter(([a, b]) => b > a)
          .sort(([a], [b]) => a - b);
        let downtime = 0,
          last = 0;
        for (const [a, b] of intervals) {
          downtime += Math.max(0, b - Math.max(a, last));
          last = Math.max(last, b);
        }
        observations.marketGaps = intervals.length;
        observations.downtimeMs = downtime;
        observations.observationCount =
          window.filter((r) => r.kind === 'LIVE_TRADE_EVIDENCE').length || null;
        observations.observedRuntimeMs =
          row.source === 'forward-replay'
            ? Date.parse(end) - Date.parse(start)
            : null;
        for (const r of window) {
          if (r.kind === 'EQUITY')
            equity.push({
              at: iso(r.at),
              equityUsd:
                r.details.valuationQuality === 'RELIABLE' &&
                typeof r.details.markedEquityUsd === 'string'
                  ? r.details.markedEquityUsd
                  : null,
              reason:
                r.details.valuationQuality === 'RELIABLE'
                  ? null
                  : 'UNCERTAIN_FORWARD_VALUATION',
            });
        }
        for (const r of runtime)
          if (
            r.kind === 'INTENT_SETTLED' ||
            r.kind === 'INTENT_OPENED' ||
            r.kind === 'ENTRY_SKIPPED'
          ) {
            const intent = r.details.intent as
              { kind?: unknown; candidate?: { id?: unknown } } | undefined;
            const signalId =
              r.kind === 'ENTRY_SKIPPED'
                ? r.details.signalId
                : intent?.kind === 'ENTRY'
                  ? intent.candidate?.id
                  : null;
            if (typeof signalId === 'string')
              intents.push({
                signalId,
                at: iso(r.at),
                status:
                  r.kind === 'INTENT_OPENED'
                    ? 'PENDING'
                    : String(r.details.status ?? 'SKIPPED'),
                reasons:
                  typeof r.details.reason === 'string'
                    ? [r.details.reason]
                    : strings(r.details.reasons),
                orderId:
                  typeof r.details.orderId === 'string'
                    ? r.details.orderId
                    : null,
              });
          }
        sourceReferences = runtime.map((r) => [
          r.id,
          iso(r.at),
          r.kind,
          r.details,
        ]);
      }
      // The ledger carries uncertainty between stored sampling times, including failed exits.
      const sampledTimes = new Set(equity.map((point) => point.at));
      for (const event of [...journal].reverse()) {
        const uncertain =
          event.stateAfter.executionUncertain ||
          event.stateAfter.positions.some(
            (p) =>
              p.status !== 'CLOSED' &&
              (!p.mark ||
                p.valuationStale ||
                p.liquidationUncertain ||
                p.status === 'EXIT_BLOCKED'),
          );
        const at = iso(event.timestamp);
        if (!sampledTimes.has(at) && (uncertain || !row.run)) {
          equity.push({
            at,
            equityUsd: uncertain ? null : event.stateAfter.equityUsd,
            reason: uncertain
              ? 'UNCERTAIN_LEDGER_VALUATION'
              : 'RECONCILED_LEDGER_MARK',
          });
          sampledTimes.add(at);
        }
      }
      equity.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const sourceFingerprint =
        row.dataset?.fingerprint ?? snapshot.definition.replayHash;
      const inputFingerprint = stableHash({
        sourceFingerprint,
        configurationHash,
        start,
        end,
        ledger: prefix.map((e) => e.eventHash),
        decisions,
        intents,
        equity,
        sourceReferences,
        observations,
      });
      return {
        source: row.source,
        portfolioId: row.portfolioId,
        strategyId: row.strategy.strategyId,
        sourceId:
          row.dataset?.sourceId ??
          (row.source === 'forward'
            ? 'PUMPPORTAL_EVIDENCE_V1'
            : snapshot.definition.name),
        runId: row.run?.id ?? null,
        definition: snapshot.definition,
        execution,
        configurationHash,
        start,
        end,
        availableStart,
        availableEnd,
        periodType,
        registration: registration ?? null,
        startState,
        endState,
        journal,
        priorOrders: prefix
          .filter((e) => Date.parse(e.timestamp) < Date.parse(start))
          .flatMap((e) => e.orders),
        decisions,
        intents,
        equity,
        observations,
        markets: row.dataset?.manifest.markets ?? [],
        quality: row.result?.runDataQuality ?? null,
        cadence: plan
          ? { startTime: plan.startTime, equityCadenceMs: plan.equityCadenceMs }
          : null,
        sourceFingerprint: sourceFingerprint!,
        inputFingerprint,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export function observationCounts(observations: SourceObservations) {
  const { discovered, analyzed, eligible, watched, ...quality } = observations;
  return {
    ...quality,
    discoveredTokens: countOrNull(discovered),
    analyzedTokens: countOrNull(analyzed),
    eligibleTokens: countOrNull(eligible),
    watchedTokens: countOrNull(watched),
  };
}
