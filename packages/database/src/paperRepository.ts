import { and, asc, eq } from 'drizzle-orm';
import {
  paperAccountDefinitionSchema,
  paperCommandSchema,
  paperOrderRecordSchema,
  paperPortfolioStateSchema,
  stableHash,
  stableId,
  strategyDecisionSchema,
  toAtomic,
} from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperCommand,
  PaperPortfolioState,
  PaperPosting,
  PaperTransition,
} from '@solemn/shared';
import type { Database } from './client.js';
import { orders, positions, tokens, trades } from './schema.js';
import { strategyDecisions, strategyRuns } from './strategySchema.js';
import { paperPortfolios, portfolioBalanceEvents } from './paperSchema.js';
export interface PaperCommit extends PaperTransition {
  duplicate: boolean;
}
export interface PaperRepository {
  snapshot(portfolioId: string): Promise<{
    definition: PaperAccountDefinition;
    state: PaperPortfolioState;
    events: (typeof portfolioBalanceEvents.$inferSelect)[];
  }>;
  initialize(
    definition: PaperAccountDefinition,
    state: PaperPortfolioState,
    posting: PaperPosting,
  ): Promise<PaperPortfolioState>;
  load(portfolioId: string): Promise<{
    definition: PaperAccountDefinition;
    state: PaperPortfolioState;
  }>;
  transact(
    portfolioId: string,
    command: PaperCommand,
    reduce: (
      state: PaperPortfolioState,
      definition: PaperAccountDefinition,
    ) => PaperTransition,
  ): Promise<PaperCommit>;
  history(
    portfolioId: string,
  ): Promise<(typeof portfolioBalanceEvents.$inferSelect)[]>;
}
const balances = (state: PaperPortfolioState) => ({
  state,
  availableCashUsd: state.availableCashUsd,
  reservedCashUsd: state.reservedCashUsd,
  equityUsd: state.equityUsd,
  status: state.status,
  updatedAt: state.asOf,
});
export function createPaperRepository(db: Database): PaperRepository {
  return {
    async snapshot(portfolioId) {
      return db.transaction(async (tx) => {
        const row = (
          await tx
            .select()
            .from(paperPortfolios)
            .where(eq(paperPortfolios.id, portfolioId))
            .for('update')
        )[0];
        if (!row) throw new Error('Unknown paper portfolio');
        const definition = paperAccountDefinitionSchema.parse(row.definition),
          state = paperPortfolioStateSchema.parse(row.state);
        const events = await tx
          .select()
          .from(portfolioBalanceEvents)
          .where(eq(portfolioBalanceEvents.portfolioId, portfolioId))
          .orderBy(asc(portfolioBalanceEvents.sequence));
        if (
          events.length !== row.version ||
          events.at(-1)?.eventHash !== row.lastEventHash
        )
          throw new Error('Portfolio journal version mismatch');
        const storedPositions = await tx
          .select()
          .from(positions)
          .where(eq(positions.portfolioId, portfolioId));
        const storedOrders = await tx
          .select()
          .from(orders)
          .where(eq(orders.portfolioId, portfolioId));
        const storedTrades = await tx
          .select()
          .from(trades)
          .where(eq(trades.portfolioId, portfolioId));
        const expectedOrders = events.flatMap((event) => event.orders),
          expectedTrades = expectedOrders.flatMap((record) => record.trades);
        if (
          storedPositions.length !== state.positions.length ||
          storedOrders.length !== expectedOrders.length ||
          storedTrades.length !== expectedTrades.length
        )
          throw new Error('Paper materialized record count mismatch');
        const atomic = (value: string) =>
          value.startsWith('-') ? -toAtomic(value.slice(1)) : toAtomic(value);
        const moneyMatches = (
          actual: string | null,
          expected: string | null,
        ) =>
          actual === null || expected === null
            ? actual === expected
            : atomic(actual) === atomic(expected);
        const timeMatches = (actual: string | null, expected: string | null) =>
          actual === null || expected === null
            ? actual === expected
            : Date.parse(actual) === Date.parse(expected);
        for (const position of state.positions) {
          const stored = storedPositions.find(
            (item) => item.id === position.id,
          );
          if (
            !stored ||
            stored.tokenMint !== position.mint ||
            stored.poolAddress !== position.poolAddress ||
            stored.paperState !== position.status ||
            stored.status !==
              (position.status === 'CLOSED' ? 'CLOSED' : 'OPEN') ||
            stableHash(stored.paperDetails) !== stableHash(position) ||
            !moneyMatches(stored.quantity, position.quantity) ||
            !moneyMatches(stored.costBasisUsd, position.costBasisUsd) ||
            !moneyMatches(
              stored.averageEntryPriceUsd,
              position.entryPriceUsd,
            ) ||
            !moneyMatches(stored.realizedPnlUsd, position.realizedPnlUsd) ||
            !moneyMatches(stored.unrealizedPnlUsd, position.unrealizedPnlUsd) ||
            !timeMatches(stored.openedAt, position.openedAt) ||
            !timeMatches(stored.closedAt, position.closedAt)
          )
            throw new Error('Paper position materialization mismatch');
        }
        for (const expected of expectedOrders) {
          const stored = storedOrders.find(
              (item) => item.id === expected.order.id,
            ),
            order = expected.order;
          if (
            !stored ||
            stableHash(stored.paperDetails) !== stableHash(expected) ||
            stored.status !== order.status ||
            stored.executionMode !== 'PAPER' ||
            stored.tokenMint !== order.tokenMint ||
            stored.side !== order.side ||
            !moneyMatches(stored.requestedQuantity, order.requestedQuantity) ||
            !moneyMatches(stored.estimatedFeesUsd, order.estimatedFeesUsd) ||
            !moneyMatches(stored.actualFeesUsd, order.actualFeesUsd) ||
            !timeMatches(stored.createdAt, order.createdAt) ||
            !timeMatches(stored.submittedAt, order.submittedAt) ||
            !timeMatches(stored.executedAt, order.executedAt)
          )
            throw new Error('Paper order materialization mismatch');
          for (const fill of expected.trades) {
            const trade = storedTrades.find((item) => item.id === fill.id);
            if (
              !trade ||
              trade.orderId !== fill.orderId ||
              trade.tokenMint !== fill.tokenMint ||
              trade.side !== fill.side ||
              trade.positionId !== expected.positionId ||
              !moneyMatches(trade.executedQuantity, fill.executedQuantity) ||
              !moneyMatches(trade.executionPriceUsd, fill.executionPriceUsd) ||
              !moneyMatches(trade.feesUsd, fill.feesUsd) ||
              !moneyMatches(trade.notionalUsd, expected.notionalUsd) ||
              !timeMatches(trade.timestamp, fill.timestamp)
            )
              throw new Error('Paper fill materialization mismatch');
          }
        }
        return { definition, state, events };
      });
    },
    async initialize(input, initial, posting) {
      const definition = paperAccountDefinitionSchema.parse(input),
        state = paperPortfolioStateSchema.parse(initial);
      if (state.id !== definition.id)
        throw new Error('Portfolio identity mismatch');
      const expectedHash = stableHash({
        policy: definition.policy,
        strategyPolicy: definition.strategyPolicy,
        riskPolicy: definition.riskPolicy,
        strategyRunId: definition.strategyRunId,
        replayHash: definition.replayHash,
      });
      if (definition.configHash !== expectedHash)
        throw new Error('Paper portfolio configuration hash mismatch');
      if (
        toAtomic(state.availableCashUsd) !==
          toAtomic(definition.policy.initialBalanceUsd) ||
        toAtomic(state.reservedCashUsd) !== 0n ||
        toAtomic(state.equityUsd) !==
          toAtomic(definition.policy.initialBalanceUsd) ||
        state.positions.length !== 0 ||
        toAtomic(state.buyFeesUsd) !== 0n ||
        toAtomic(state.sellFeesUsd) !== 0n ||
        state.realizedPnlUsd !== '0'
      )
        throw new Error('Invalid initial paper portfolio balance');
      return db.transaction(async (tx) => {
        const run = (
          await tx
            .select()
            .from(strategyRuns)
            .where(eq(strategyRuns.id, definition.strategyRunId))
        )[0];
        if (
          run?.mode !== 'FIXTURE' ||
          run.configHash !== stableHash(definition.strategyPolicy) ||
          run.riskPolicyHash !== stableHash(definition.riskPolicy)
        )
          throw new Error(
            'Paper replay requires its matching persisted fixture strategy run',
          );
        const id = stableId(['paper-initial-balance-v1', definition.id]),
          event = {
            id,
            portfolioId: definition.id,
            sequence: 1,
            timestamp: new Date(definition.createdAt).toISOString(),
            command: null,
            inputHash: stableHash(definition),
            postings: [posting],
            orders: [],
            result: {
              outcome: 'RESET' as const,
              reasons: ['PORTFOLIO_INITIALIZED'],
              orderId: null,
              positionId: null,
            },
            stateAfter: state,
            previousHash: null,
          };
        const eventHash = stableHash(event);
        const inserted = await tx
          .insert(paperPortfolios)
          .values({
            id: definition.id,
            name: definition.name,
            mode: definition.mode,
            dataMode: definition.dataMode,
            strategyRunId: definition.strategyRunId,
            configHash: definition.configHash,
            definition,
            ...balances(state),
            version: 1,
            lastEventHash: eventHash,
            createdAt: definition.createdAt,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length) {
          await tx
            .insert(portfolioBalanceEvents)
            .values({ ...event, eventHash });
          return state;
        }
        const existing = (
          await tx
            .select()
            .from(paperPortfolios)
            .where(eq(paperPortfolios.id, definition.id))
        )[0];
        if (
          !existing ||
          existing.configHash !== definition.configHash ||
          existing.strategyRunId !== definition.strategyRunId
        )
          throw new Error(
            'Portfolio configuration is immutable; use a separate portfolio',
          );
        return paperPortfolioStateSchema.parse(existing.state);
      });
    },
    async load(portfolioId) {
      const row = (
        await db
          .select()
          .from(paperPortfolios)
          .where(eq(paperPortfolios.id, portfolioId))
      )[0];
      if (!row) throw new Error('Unknown paper portfolio');
      return {
        definition: paperAccountDefinitionSchema.parse(row.definition),
        state: paperPortfolioStateSchema.parse(row.state),
      };
    },
    async history(portfolioId) {
      return db
        .select()
        .from(portfolioBalanceEvents)
        .where(eq(portfolioBalanceEvents.portfolioId, portfolioId))
        .orderBy(asc(portfolioBalanceEvents.sequence));
    },
    async transact(portfolioId, input, reduce) {
      const command = paperCommandSchema.parse(input),
        inputHash = stableHash(command);
      return db.transaction(async (tx) => {
        const row = (
          await tx
            .select()
            .from(paperPortfolios)
            .where(eq(paperPortfolios.id, portfolioId))
            .for('update')
        )[0];
        if (!row) throw new Error('Unknown paper portfolio');
        const definition = paperAccountDefinitionSchema.parse(row.definition),
          current = paperPortfolioStateSchema.parse(row.state);
        const existing = (
          await tx
            .select()
            .from(portfolioBalanceEvents)
            .where(eq(portfolioBalanceEvents.id, command.id))
        )[0];
        if (existing) {
          if (
            existing.portfolioId !== portfolioId ||
            existing.inputHash !== inputHash
          )
            throw new Error('Paper idempotency conflict');
          return {
            state: current,
            postings: existing.postings,
            orders: existing.orders,
            result: existing.result,
            duplicate: true,
          };
        }
        const last = (
          await tx
            .select()
            .from(portfolioBalanceEvents)
            .where(
              and(
                eq(portfolioBalanceEvents.portfolioId, portfolioId),
                eq(portfolioBalanceEvents.sequence, row.version),
              ),
            )
        )[0];
        if (
          !last ||
          last.eventHash !== row.lastEventHash ||
          stableHash(last.stateAfter) !== stableHash(current)
        )
          throw new Error(
            'Portfolio snapshot/ledger mismatch; reconciliation required',
          );
        if (command.type === 'ENTRY') {
          const decision = (
            await tx
              .select()
              .from(strategyDecisions)
              .where(
                and(
                  eq(strategyDecisions.signalId, command.candidate.id),
                  eq(strategyDecisions.runId, definition.strategyRunId),
                ),
              )
          )[0];
          if (
            !decision ||
            decision.mode !== 'FIXTURE' ||
            stableHash(
              strategyDecisionSchema.parse(decision.payload).candidate,
            ) !== stableHash(command.candidate)
          )
            throw new Error(
              'Entry requires an authentic persisted fixture candidate',
            );
        }
        const transition = reduce(current, definition);
        paperPortfolioStateSchema.parse(transition.state);
        if (transition.state.id !== portfolioId)
          throw new Error('Portfolio reducer identity mismatch');
        // Pure reducer has completed; all materialized rows and ledger postings commit together.
        if (
          transition.state.positions.some(
            (position) => position.portfolioId !== portfolioId,
          ) ||
          new Set(transition.state.positions.map((position) => position.id))
            .size !== transition.state.positions.length
        )
          throw new Error('Paper position ownership/identity mismatch');
        const changed = transition.state.positions.filter(
          (position) =>
            stableHash(position) !==
            stableHash(
              current.positions.find((old) => old.id === position.id) ?? null,
            ),
        );
        for (const position of changed) {
          if (position.portfolioId !== portfolioId)
            throw new Error('Paper position ownership mismatch');
          await tx
            .insert(tokens)
            .values({
              mintAddress: position.mint,
              discoveredAt: definition.createdAt,
              sourcePlatform: 'PAPER_FIXTURE',
              riskStatus: 'UNKNOWN',
            })
            .onConflictDoNothing();
          const values = {
            portfolioId,
            poolAddress: position.poolAddress,
            paperState: position.status,
            paperDetails: position,
            tokenMint: position.mint,
            quantity: position.quantity,
            averageEntryPriceUsd: position.entryPriceUsd,
            costBasisUsd: position.costBasisUsd,
            realizedPnlUsd: position.realizedPnlUsd,
            unrealizedPnlUsd: position.unrealizedPnlUsd,
            status:
              position.status === 'CLOSED'
                ? ('CLOSED' as const)
                : ('OPEN' as const),
            openedAt: position.openedAt,
            closedAt: position.closedAt,
          };
          await tx
            .insert(positions)
            .values({ id: position.id, ...values })
            .onConflictDoUpdate({
              target: positions.id,
              set: values,
              setWhere: eq(positions.portfolioId, portfolioId),
            });
        }
        for (const inputRecord of transition.orders) {
          const record = paperOrderRecordSchema.parse(inputRecord),
            order = record.order;
          if (
            order.executionMode !== 'PAPER' ||
            (order.status === 'FILLED') !== (record.trades.length === 1)
          )
            throw new Error('Invalid paper order/fill lifecycle');
          await tx
            .insert(tokens)
            .values({
              mintAddress: order.tokenMint,
              discoveredAt: definition.createdAt,
              sourcePlatform: 'PAPER_FIXTURE',
              riskStatus: 'UNKNOWN',
            })
            .onConflictDoNothing();
          const positionExists = transition.state.positions.some(
            (position) => position.id === record.positionId,
          );
          await tx.insert(orders).values({
            ...order,
            portfolioId,
            paperPositionId: positionExists ? record.positionId : null,
            strategyCandidateId: record.signalId,
            paperDetails: record,
          });
          for (const fill of record.trades) {
            if (
              fill.orderId !== order.id ||
              fill.executedQuantity !== order.requestedQuantity ||
              fill.feesUsd !== order.actualFeesUsd
            )
              throw new Error('Paper fill does not reconcile with its order');
            await tx.insert(trades).values({
              ...fill,
              portfolioId,
              positionId: record.positionId,
              notionalUsd: record.notionalUsd,
            });
          }
        }
        // Validate posting totals independently of the reducer before accepting money changes.
        const signed = (value: string) =>
          value.startsWith('-') ? -toAtomic(value.slice(1)) : toAtomic(value);
        for (const [field, delta] of [
          ['availableCashUsd', 'availableDeltaUsd'],
          ['reservedCashUsd', 'reservedDeltaUsd'],
          ['realizedPnlUsd', 'realizedDeltaUsd'],
          ['buyFeesUsd', 'buyFeesDeltaUsd'],
          ['sellFeesUsd', 'sellFeesDeltaUsd'],
        ] as const) {
          if (
            signed(transition.state[field]) !==
            signed(current[field]) +
              transition.postings.reduce(
                (sum, posting) => sum + signed(posting[delta]),
                0n,
              )
          )
            throw new Error('Paper posting totals do not reconcile');
        }
        const event = {
          id: command.id,
          portfolioId,
          sequence: row.version + 1,
          timestamp: new Date(transition.state.asOf).toISOString(),
          command,
          inputHash,
          postings: transition.postings,
          orders: transition.orders,
          result: transition.result,
          stateAfter: transition.state,
          previousHash: row.lastEventHash,
        };
        const eventHash = stableHash(event);
        await tx.insert(portfolioBalanceEvents).values({ ...event, eventHash });
        await tx
          .update(paperPortfolios)
          .set({
            ...balances(transition.state),
            version: row.version + 1,
            lastEventHash: eventHash,
          })
          .where(eq(paperPortfolios.id, portfolioId));
        return { ...transition, duplicate: false };
      });
    },
  };
}
