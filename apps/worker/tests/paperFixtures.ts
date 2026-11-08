import { stableHash, stableId } from '@solemn/shared';
import type {
  PaperAccountDefinition,
  PaperCommand,
  PaperPortfolioState,
  PaperPosting,
} from '@solemn/shared';
import type { PaperRepository } from '@solemn/database';
import { loadConfig } from '../src/config/index.js';
import { createPaperReplayFixture } from '../src/portfolio/replayFixture.js';
import { replayStrategy } from '../src/strategy/replay.js';
import { paperDefinition } from '../src/portfolio/paperReplay.js';
import {
  initialPortfolio,
  initialPosting,
} from '../src/portfolio/accountingService.js';
import { memoryStrategyRepository } from './strategyFixtures.js';
export const paperConfig = loadConfig({
  DATABASE_URL: 'postgresql://solemn:password@localhost:55432/solemn',
  PAPER_ALLOW_FIXTURE_SIGNALS: 'true',
});
export function memoryPaperRepository() {
  const accounts = new Map<
    string,
    { definition: PaperAccountDefinition; state: PaperPortfolioState }
  >();
  const events: Awaited<ReturnType<PaperRepository['history']>> = [];
  const repository: PaperRepository = {
    async snapshot(id) {
      const account = accounts.get(id);
      if (!account) throw new Error('Unknown portfolio');
      return structuredClone({
        ...account,
        events: events.filter((event) => event.portfolioId === id),
      });
    },
    async initialize(definition, state, posting) {
      const existing = accounts.get(definition.id);
      if (existing) {
        if (existing.definition.configHash !== definition.configHash)
          throw new Error('Portfolio configuration is immutable');
        return structuredClone(existing.state);
      }
      const fields = {
        id: stableId(['paper-initial-balance-v1', definition.id]),
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
      events.push(
        structuredClone({ ...fields, eventHash: stableHash(fields) }),
      );
      accounts.set(definition.id, structuredClone({ definition, state }));
      return state;
    },
    async load(id) {
      const account = accounts.get(id);
      if (!account) throw new Error('Unknown portfolio');
      return structuredClone(account);
    },
    async history(id) {
      return structuredClone(
        events.filter((event) => event.portfolioId === id),
      );
    },
    async transact(id, command, reduce) {
      const account = accounts.get(id);
      if (!account) throw new Error('Unknown portfolio');
      const existing = events.find((event) => event.id === command.id);
      if (existing) {
        if (existing.inputHash !== stableHash(command))
          throw new Error('Paper idempotency conflict');
        return {
          state: structuredClone(account.state),
          postings: existing.postings,
          orders: existing.orders,
          result: existing.result,
          duplicate: true,
        };
      }
      const result = reduce(structuredClone(account.state), account.definition),
        history = events.filter((event) => event.portfolioId === id),
        last = history.at(-1)!;
      const fields = {
        id: command.id,
        portfolioId: id,
        sequence: history.length + 1,
        timestamp: new Date(result.state.asOf).toISOString(),
        command,
        inputHash: stableHash(command),
        postings: result.postings,
        orders: result.orders,
        result: result.result,
        stateAfter: result.state,
        previousHash: last.eventHash,
      };
      events.push(
        structuredClone({ ...fields, eventHash: stableHash(fields) }),
      );
      account.state = structuredClone(result.state);
      return { ...result, duplicate: false };
    },
  };
  return { repository, accounts, events };
}
export async function paperEntrySetup() {
  const fixture = createPaperReplayFixture(paperConfig),
    strategy = await replayStrategy(
      fixture.marketDataset,
      paperConfig,
      memoryStrategyRepository().repository,
    );
  const candidate = strategy.decisions.find(
    (decision) => decision.candidate,
  )!.candidate!;
  const risk = strategy.decisions.find((decision) => decision.candidate)!.risk;
  const definition = paperDefinition(paperConfig, strategy.run.id, fixture);
  const state = initialPortfolio(definition),
    posting: PaperPosting = initialPosting(definition);
  const command: Extract<PaperCommand, { type: 'ENTRY' }> = {
    type: 'ENTRY',
    id: stableId(['paper-entry-v1', definition.id, candidate.id]),
    at: candidate.timestamp,
    candidate,
    risk,
    observation: fixture.observations[0]!,
  };
  return { fixture, definition, state, posting, command };
}
