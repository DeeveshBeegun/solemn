import { and, eq, gte, lte, ne, or, sql } from 'drizzle-orm';
import {
  backtestRuns,
  strategyEvaluations,
  strategyEvaluationPeriods,
  strategyRuns,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableHash, stableId } from '@solemn/shared';
import { iso, reportVersion } from './contracts.js';
import type { Selection, Source } from './contracts.js';
import { selectPortfolio, verifyConfiguration } from './readEvaluation.js';
import type { Evaluation } from './strategyEvaluator.js';
import type { compareEvaluations } from './performanceComparison.js';

export interface EvaluationBody {
  source: Source;
  strategyId: string;
  requestedStart: string | null;
  requestedEnd: string | null;
  status: Evaluation['status'];
  reason: string | null;
  evaluation: Evaluation | null;
  comparison: ReturnType<typeof compareEvaluations> | null;
  inputFingerprint: string;
}
export type SavedEvaluation = EvaluationBody & {
  id: string;
  reportVersion: typeof reportVersion;
  generatedAt: string;
};

async function lockResearch(db: Database, strategyId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${strategyId},9))`,
  );
}

export async function registerPeriod(db: Database, selection: Selection) {
  if (
    !selection.portfolioId ||
    !selection.start ||
    !selection.end ||
    !selection.type ||
    selection.periodId
  )
    throw new Error(
      'Registration requires a portfolio, explicit type and both dates',
    );
  const startAt = iso(selection.start),
    endAt = iso(selection.end),
    kind = selection.type;
  if (Date.parse(startAt) <= Date.now() || startAt >= endAt)
    throw new Error('Prospective registration requires a future interval');
  return db.transaction(async (tx) => {
    await lockResearch(tx, selection.strategyId);
    const row = await selectPortfolio(tx, selection);
    if (!row) throw new Error('Portfolio does not match the selected source');
    const { configurationHash } = verifyConfiguration(row);
    if ((kind === 'HOLDOUT' || kind === 'FORWARD') && row.source !== 'forward')
      throw new Error(
        'Prospective empirical periods require a live forward portfolio',
      );
    if (
      row.run ||
      Date.parse(startAt) <=
        Date.parse(row.forward?.heartbeatAt ?? row.definition.createdAt)
    )
      throw new Error('Period overlaps a stored observation range');
    const fields = {
      portfolioId: row.portfolioId,
      strategyId: row.strategy.strategyId,
      strategyVersion: row.strategy.strategyVersion,
      configurationHash,
      source: row.source,
      kind,
      startAt,
      endAt,
    };
    const id = stableId(['solemn-registered-period-v1', fields]);
    const previous = (
      await tx
        .select()
        .from(strategyEvaluationPeriods)
        .where(eq(strategyEvaluationPeriods.id, id))
    )[0];
    if (previous) return previous;
    const isolate = kind === 'HOLDOUT' || kind === 'VALIDATION';
    const overlaps = await tx
      .select({ id: strategyEvaluationPeriods.id })
      .from(strategyEvaluationPeriods)
      .where(
        and(
          eq(strategyEvaluationPeriods.strategyId, selection.strategyId),
          lte(strategyEvaluationPeriods.startAt, endAt),
          gte(strategyEvaluationPeriods.endAt, startAt),
          isolate
            ? undefined
            : or(
                eq(strategyEvaluationPeriods.kind, 'HOLDOUT'),
                eq(strategyEvaluationPeriods.kind, 'VALIDATION'),
              ),
        ),
      )
      .limit(1);
    if (overlaps.length)
      throw new Error('Period overlaps an isolated registration');
    if (isolate) {
      const used = await tx
        .select({ id: strategyEvaluations.id })
        .from(strategyEvaluations)
        .where(
          and(
            eq(strategyEvaluations.strategyId, selection.strategyId),
            lte(strategyEvaluations.startAt, endAt),
            gte(strategyEvaluations.endAt, startAt),
          ),
        )
        .limit(1);
      const replayed = await tx
        .select({ id: backtestRuns.id })
        .from(backtestRuns)
        .innerJoin(
          strategyRuns,
          eq(strategyRuns.id, backtestRuns.strategyRunId),
        )
        .where(
          and(
            eq(strategyRuns.strategyId, selection.strategyId),
            sql`(${backtestRuns.plan}->>'startTime')::timestamptz <= ${endAt}::timestamptz`,
            sql`(${backtestRuns.plan}->>'endTime')::timestamptz >= ${startAt}::timestamptz`,
          ),
        )
        .limit(1);
      if (used.length || replayed.length)
        throw new Error('Interval already has evaluation or backtest evidence');
    }
    return (
      await tx
        .insert(strategyEvaluationPeriods)
        .values({ id, ...fields })
        .returning()
    )[0]!;
  });
}

export async function saveEvaluation(
  db: Database,
  body: EvaluationBody,
): Promise<SavedEvaluation> {
  const p = body.evaluation?.provenance;
  const id = stableId([
    reportVersion,
    body.source,
    body.strategyId,
    p?.portfolioId ?? null,
    p?.registration?.id ?? null,
    p?.periodType ?? null,
    body.inputFingerprint,
  ]);
  return db.transaction(async (tx) => {
    await lockResearch(tx, body.strategyId);
    const startAt = p?.start ?? body.requestedStart,
      endAt = p?.end ?? body.requestedEnd;
    if (startAt && endAt) {
      const overlap = await tx
        .select({ id: strategyEvaluationPeriods.id })
        .from(strategyEvaluationPeriods)
        .where(
          and(
            eq(strategyEvaluationPeriods.strategyId, body.strategyId),
            eq(strategyEvaluationPeriods.kind, 'HOLDOUT'),
            lte(strategyEvaluationPeriods.startAt, endAt),
            gte(strategyEvaluationPeriods.endAt, startAt),
            p?.registration
              ? ne(strategyEvaluationPeriods.id, p.registration.id)
              : undefined,
          ),
        )
        .limit(1);
      if (overlap.length)
        throw new Error('Report overlaps a sealed holdout period');
    }
    await tx
      .insert(strategyEvaluations)
      .values({
        id,
        portfolioId: p?.portfolioId ?? null,
        periodId: p?.registration?.id ?? null,
        strategyId: body.strategyId,
        strategyVersion: p?.strategyVersion ?? null,
        source: body.source,
        configurationHash: p?.configurationHash ?? null,
        inputFingerprint: body.inputFingerprint,
        status: body.status,
        reportVersion,
        startAt,
        endAt,
        payload: body,
      })
      .onConflictDoNothing();
    const row = (
      await tx
        .select()
        .from(strategyEvaluations)
        .where(eq(strategyEvaluations.id, id))
    )[0];
    if (!row || stableHash(row.payload) !== stableHash(body))
      throw new Error('Immutable evaluation identity conflict');
    return { ...body, id, reportVersion, generatedAt: iso(row.generatedAt) };
  });
}
