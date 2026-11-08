import { eq, and, desc } from 'drizzle-orm';
import {
  marketCandleSchema,
  marketCorrectionSchema,
  marketDatasetSchema,
  marketTradeSchema,
  stableHash,
  stableId,
  strategyDecisionSchema,
  strategyPolicySchema,
  tokenRiskAssessmentSchema,
} from '@solemn/shared';
import type {
  MarketCandle,
  MarketCorrection,
  MarketDataset,
  StrategyDecision,
  StrategyPolicy,
} from '@solemn/shared';
import type { Database } from './client.js';
import { listEligibleRiskCandidates } from './riskRepository.js';
import { tokenRiskAssessments } from './schema.js';
import {
  strategyRuns,
  marketTradeObservations,
  marketCoverageObservations,
  marketCandles,
  marketCorrections,
  strategyDecisions,
} from './strategySchema.js';

export interface StrategyRun {
  id: string;
  mode: 'FIXTURE' | 'LIVE_NOT_READY';
  strategyId: string;
  strategyVersion: string;
  configHash: string;
  riskPolicyHash: string;
  config: StrategyPolicy;
  datasetHash: string | null;
  dataset: MarketDataset | null;
}
export function strategyRun(
  policy: StrategyPolicy,
  riskHash: string,
  dataset: MarketDataset | null,
): StrategyRun {
  const config = strategyPolicySchema.parse(policy);
  const datasetHash =
    dataset === null ? null : stableHash(marketDatasetSchema.parse(dataset));
  const mode = dataset ? 'FIXTURE' : 'LIVE_NOT_READY';
  const configHash = stableHash(config);
  return {
    id: stableId(['strategy-run-v1', mode, configHash, riskHash, datasetHash]),
    mode,
    strategyId: config.strategyId,
    strategyVersion: config.version,
    configHash,
    riskPolicyHash: riskHash,
    config,
    datasetHash,
    dataset,
  };
}
export interface StrategyRepository {
  begin(run: StrategyRun): Promise<void>;
  save(
    run: StrategyRun,
    decision: StrategyDecision,
    candles: readonly MarketCandle[],
    corrections: readonly MarketCorrection[],
  ): Promise<'INSERTED' | 'DUPLICATE'>;
}
export function createStrategyRepository(db: Database): StrategyRepository {
  return {
    async begin(run) {
      await db.transaction(async (tx) => {
        await tx.insert(strategyRuns).values(run).onConflictDoNothing();
        if (run.dataset === null) return;
        for (const market of run.dataset.markets) {
          const ordered = [...market.trades].sort(
            (a, b) =>
              Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
              a.id.localeCompare(b.id),
          );
          for (let offset = 0; offset < ordered.length; offset += 100) {
            const rows = ordered.slice(offset, offset + 100).map((input) => {
              const trade = marketTradeSchema.parse(input);
              return {
                runId: run.id,
                id: trade.id,
                tokenMint: trade.mint,
                poolAddress: trade.poolAddress,
                source: trade.source,
                sourceEventId: trade.sourceEventId,
                timestamp: trade.timestamp,
                receivedAt: trade.receivedAt,
                payload: trade,
              };
            });
            if (rows.length)
              await tx
                .insert(marketTradeObservations)
                .values(rows)
                .onConflictDoNothing();
          }
          if (market.coverage.length)
            await tx
              .insert(marketCoverageObservations)
              .values(
                market.coverage.map((coverage) => ({
                  ...coverage,
                  runId: run.id,
                  tokenMint: market.mint,
                  poolAddress: market.poolAddress,
                })),
              )
              .onConflictDoNothing();
        }
      });
    },
    async save(run, input, candles, corrections) {
      const decision = strategyDecisionSchema.parse(input);
      if (decision.runId !== run.id)
        throw new Error('Strategy decision run mismatch');
      if (decision.outcome === 'BUY_CANDIDATE' && run.mode !== 'FIXTURE')
        throw new Error('Live strategy generation is NOT_READY');
      return db.transaction(async (tx) => {
        if (candles.length)
          await tx
            .insert(marketCandles)
            .values(
              candles.map((input) => {
                const candle = marketCandleSchema.parse(input);
                return {
                  runId: run.id,
                  id: candle.id,
                  tokenMint: candle.mint,
                  poolAddress: candle.poolAddress,
                  startTime: candle.startTime,
                  endTime: candle.endTime,
                  payload: candle,
                };
              }),
            )
            .onConflictDoNothing();
        if (corrections.length)
          await tx
            .insert(marketCorrections)
            .values(
              corrections.map((input) => {
                const correction = marketCorrectionSchema.parse(input);
                return {
                  runId: run.id,
                  id: correction.id,
                  tokenMint: decision.mint,
                  poolAddress: decision.poolAddress as string,
                  receivedAt: correction.receivedAt,
                  reason: correction.reason,
                  payload: correction,
                };
              }),
            )
            .onConflictDoNothing();
        const inserted = await tx
          .insert(strategyDecisions)
          .values({
            id: decision.id,
            runId: run.id,
            mode: run.mode,
            tokenMint: decision.mint,
            poolAddress: decision.poolAddress,
            timestamp: decision.timestamp,
            candleId: decision.candleId,
            outcome: decision.outcome,
            opportunityKey: decision.candidate?.opportunityKey ?? null,
            signalId: decision.candidate?.id ?? null,
            payload: decision,
          })
          .onConflictDoNothing()
          .returning({ id: strategyDecisions.id });
        return inserted.length ? 'INSERTED' : 'DUPLICATE';
      });
    },
  };
}

export async function currentStrategyRisks(
  db: Database,
  now: string,
  riskHash: string,
  limit: number,
) {
  const candidates = await listEligibleRiskCandidates(db, now, riskHash, limit);
  const result = [];
  for (const candidate of candidates) {
    const row = (
      await db
        .select()
        .from(tokenRiskAssessments)
        .where(eq(tokenRiskAssessments.id, candidate.assessmentId))
    )[0];
    if (!row) continue;
    const { policyVersion, createdAt, ...data } = row;
    void policyVersion;
    void createdAt;
    const assessment = tokenRiskAssessmentSchema.parse({
      ...data,
      requestedAt: new Date(row.requestedAt).toISOString(),
      assessedAt: new Date(row.assessedAt).toISOString(),
      validUntil:
        row.validUntil === null ? null : new Date(row.validUntil).toISOString(),
    });
    result.push(assessment);
  }
  return result;
}

/** Explicit opt-in is mandatory for consuming synthetic research candidates. No live candidates exist in Week 4. */
export async function listFixtureBuyCandidates(
  db: Database,
  runId: string,
  allowFixture: boolean,
) {
  if (!allowFixture)
    throw new Error(
      'Fixture candidate consumption requires explicit opt-in; live strategy is NOT_READY',
    );
  const rows = await db
    .select()
    .from(strategyDecisions)
    .where(
      and(
        eq(strategyDecisions.runId, runId),
        eq(strategyDecisions.mode, 'FIXTURE'),
        eq(strategyDecisions.outcome, 'BUY_CANDIDATE'),
      ),
    )
    .orderBy(desc(strategyDecisions.timestamp));
  return rows.map((row) => strategyDecisionSchema.parse(row.payload).candidate);
}
