import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  createPaperRepository,
  marketTradeObservations,
  portfolioBalanceEvents,
  strategyDecisions,
  tokens,
  tokenRiskAssessments,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import { stableId, tokenRiskAssessmentSchema } from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperCommand,
  StrategyRiskContext,
} from '@solemn/shared';
import type { Logger } from 'pino';
import type { FreeMarketSnapshot } from '../market/freeGeckoClient.js';
import {
  freeSpotObservation,
  isLaterPaperObservation,
} from '../execution/freeSpotExecution.js';
import { applyPaperCommand } from './portfolioManager.js';

/** Only called on the session that holds this account's advisory lock.
 * Pending entries are persisted strategy decisions without an ENTRY ledger event.
 * Pending exits and their trigger times are recovered from positions and the ledger. */
export function createFreePaperExecutor(
  definition: PaperAccountDefinition,
  logger: Logger,
  timestamp: () => string,
) {
  if (!definition.freeExecution)
    throw new Error('Free paper execution is not configured');
  async function risk(
    db: Database,
    mint: string,
    at: string,
  ): Promise<StrategyRiskContext | null> {
    const row = (
      await db
        .select({ token: tokens, assessment: tokenRiskAssessments })
        .from(tokens)
        .leftJoin(
          tokenRiskAssessments,
          eq(tokens.latestRiskAssessmentId, tokenRiskAssessments.id),
        )
        .where(eq(tokens.mintAddress, mint))
        .limit(1)
    )[0];
    if (!row) return null;
    const a = row.assessment;
    const data = a
      ? (({ policyVersion, createdAt, ...rest }) => {
          void policyVersion;
          void createdAt;
          return rest;
        })(a)
      : null;
    return {
      currentStatus: row.token.riskStatus,
      currentRequestId: row.token.riskRequestId,
      availableAt: at,
      assessment: a
        ? tokenRiskAssessmentSchema.parse({
            ...data,
            requestedAt: new Date(a.requestedAt).toISOString(),
            assessedAt: new Date(a.assessedAt).toISOString(),
            validUntil: a.validUntil
              ? new Date(a.validUntil).toISOString()
              : null,
          })
        : null,
    };
  }
  async function pending(db: Database) {
    return db
      .select()
      .from(strategyDecisions)
      .where(
        and(
          eq(strategyDecisions.runId, definition.strategyRunId),
          eq(strategyDecisions.outcome, 'BUY_CANDIDATE'),
          sql`NOT EXISTS (SELECT 1 FROM portfolio_balance_events e WHERE e.portfolio_id=${definition.id}
        AND e.command->>'type'='ENTRY' AND e.command->'candidate'->>'id'=${strategyDecisions.signalId}::text)`,
        ),
      )
      .orderBy(asc(strategyDecisions.timestamp), asc(strategyDecisions.id))
      .limit(100);
  }
  async function commit(db: Database, command: PaperCommand) {
    const result = await createPaperRepository(db).transact(
      definition.id,
      command,
      (state, account) => applyPaperCommand(state, command, account),
    );
    if (
      !result.duplicate &&
      !['MARK_UPDATED', 'NO_POSITION', 'STALE_DATA'].includes(
        result.result.outcome,
      )
    )
      logger.info(
        {
          portfolioId: definition.id,
          outcome: result.result.outcome,
          reason: result.result.reasons.join(','),
          executionModel: definition.freeExecution!.model,
        },
        'Live paper simulated execution',
      );
    return result;
  }
  async function expire(db: Database) {
    const at = timestamp();
    for (const decision of await pending(db)) {
      const candidate = decision.payload.candidate!;
      if (
        Date.parse(at) - Date.parse(candidate.timestamp) <=
        definition.policy.maxSignalAgeSeconds * 1000
      )
        continue;
      await commit(db, {
        type: 'ENTRY',
        id: stableId(['paper-entry-v1', definition.id, candidate.id]),
        at,
        candidate,
        risk: await risk(db, candidate.mint, at),
        observation: null,
      });
    }
    const state = (await createPaperRepository(db).load(definition.id)).state;
    if (state.positions.some((p) => p.status !== 'CLOSED') && state.asOf < at)
      await commit(db, {
        type: 'TICK',
        id: stableId(['free-paper-tick-v1', definition.id, at]),
        at,
      });
  }
  async function unavailable(db: Database, mint: string, reason: string) {
    const state = (await createPaperRepository(db).load(definition.id)).state;
    const position = state.positions.find(
      (p) => p.mint === mint && p.status !== 'CLOSED',
    );
    if (!position) return;
    const at = timestamp();
    // No liquidation at an old price. Keep holdings and make uncertain valuation visible.
    await commit(db, {
      type: 'FEED_UNAVAILABLE',
      id: stableId(['free-paper-gap-v1', definition.id, mint, at, reason]),
      at,
      reason,
    });
    if (position.pendingExitReason)
      await commit(db, {
        type: 'EXIT_UNAVAILABLE',
        id: stableId([
          'free-paper-exit-gap-v1',
          definition.id,
          position.id,
          at,
          reason,
        ]),
        at,
        positionId: position.id,
        reason,
      });
  }
  async function process(db: Database, snapshot: FreeMarketSnapshot) {
    await db.transaction(async (tx) => {
      if (snapshot.trades.length)
        await tx
          .insert(marketTradeObservations)
          .values(
            snapshot.trades.map((trade) => ({
              runId: definition.strategyRunId,
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
      const at = timestamp();
      const buy = freeSpotObservation(snapshot, 'BUY', at, definition.policy);
      const sell = freeSpotObservation(snapshot, 'SELL', at, definition.policy);
      if (!buy || !sell) {
        await unavailable(
          tx,
          snapshot.mint,
          'FREE_EXECUTION_PRICE_UNAVAILABLE_OR_STALE',
        );
        return;
      }
      const context = await risk(tx, snapshot.mint, at);
      // A later public trade is required. Never fill from the triggering candle or a cached old trade.
      for (const decision of await pending(tx)) {
        const candidate = decision.payload.candidate!;
        if (
          candidate.mint !== snapshot.mint ||
          candidate.poolAddress !== snapshot.pool ||
          !isLaterPaperObservation(buy, candidate.timestamp)
        )
          continue;
        await commit(tx, {
          type: 'ENTRY',
          id: stableId(['paper-entry-v1', definition.id, candidate.id]),
          at,
          candidate,
          risk: context,
          observation: buy,
        });
      }
      const state = (await createPaperRepository(tx).load(definition.id)).state;
      const position = state.positions.find(
        (p) =>
          p.mint === snapshot.mint &&
          p.poolAddress === snapshot.pool &&
          p.status !== 'CLOSED',
      );
      if (
        !position ||
        (position.mark &&
          Date.parse(position.mark.observedAt) >= Date.parse(sell.observedAt))
      )
        return;
      const trigger = position.pendingExitReason
        ? (
            await tx
              .select({ at: portfolioBalanceEvents.timestamp })
              .from(portfolioBalanceEvents)
              .where(
                and(
                  eq(portfolioBalanceEvents.portfolioId, definition.id),
                  sql`${portfolioBalanceEvents.result}->>'positionId'=${position.id} AND ${portfolioBalanceEvents.result}->>'outcome'='EXIT_SCHEDULED'`,
                ),
              )
              .orderBy(desc(portfolioBalanceEvents.sequence))
              .limit(1)
          )[0]?.at
        : null;
      await commit(tx, {
        type: 'MARK',
        id: stableId(['paper-mark-v1', definition.id, sell.id]),
        at,
        observation: sell,
        risk: context,
        deferExecution: !trigger || !isLaterPaperObservation(sell, trigger),
      });
    });
  }
  return { process, expire, unavailable };
}
