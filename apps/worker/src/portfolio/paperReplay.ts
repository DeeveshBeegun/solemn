import {
  paperAccountDefinitionSchema,
  paperReplaySchema,
  stableHash,
  stableId,
} from '@solemn/shared';
import type { BuyCandidate, PaperCommand, PaperReplay } from '@solemn/shared';
import type { PaperRepository, StrategyRepository } from '@solemn/database';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { FixtureReplayProvider } from '../analysis/marketDataProvider.js';
import { replayStrategy } from '../strategy/replay.js';
import { riskPolicy } from '../risk/tokenRiskEngine.js';
import { strategyPolicy } from '../strategy/signalEngine.js';
import { paperPolicy } from './policy.js';
import { initialPortfolio, initialPosting } from './accountingService.js';
import { applyPaperCommand } from './portfolioManager.js';
import { recoverPortfolio } from './recovery.js';
import { safeError } from '../services/logger.js';
import { createPositionMonitor } from './positionMonitor.js';
export function paperDefinition(
  config: Config,
  strategyRunId: string,
  replay: PaperReplay,
) {
  const configuration = {
    policy: paperPolicy(config),
    strategyPolicy: strategyPolicy(config),
    riskPolicy: riskPolicy(config),
    strategyRunId,
    replayHash: stableHash(replay),
  };
  const configHash = stableHash(configuration);
  return paperAccountDefinitionSchema.parse({
    ...configuration,
    configHash,
    id:
      config.PAPER_PORTFOLIO_ID ||
      stableId([
        'paper-portfolio-v1',
        config.PAPER_PORTFOLIO_NAME,
        configHash,
        stableHash(replay),
      ]),
    name: config.PAPER_PORTFOLIO_NAME,
    mode: 'PAPER',
    currency: 'USD',
    dataMode: 'FIXTURE',
    createdAt: new Date(replay.marketDataset.start).toISOString(),
  });
}
export async function replayPaperTrading(
  input: unknown,
  config: Config,
  strategyRepository: StrategyRepository,
  repository: PaperRepository,
  logger?: Logger,
  signal?: AbortSignal,
) {
  if (!config.PAPER_ALLOW_FIXTURE_SIGNALS)
    throw new Error('Paper replay requires explicit fixture opt-in');
  logger?.info(
    { mode: 'PAPER', dataMode: 'FIXTURE' },
    'Paper trading replay started',
  );
  const replay = paperReplaySchema.parse(input),
    provider = new FixtureReplayProvider(
      replay.marketDataset,
      config.MARKET_DATA_MAX_TRACKED_TOKENS,
    );
  for (const observation of replay.observations)
    provider.market(observation.mint, observation.poolAddress);
  const strategy = await replayStrategy(
    replay.marketDataset,
    config,
    strategyRepository,
    undefined,
    signal,
  );
  const definition = paperDefinition(config, strategy.run.id, replay);
  await repository.initialize(
    definition,
    initialPortfolio(definition),
    initialPosting(definition),
  );
  const recovered = await recoverPortfolio(repository, definition.id);
  logger?.info(
    {
      portfolioId: definition.id,
      recoveredEvents: recovered.eventCount,
      cashUsd: recovered.state.availableCashUsd,
    },
    recovered.eventCount === 1
      ? 'Paper portfolio initialized'
      : 'Paper portfolio recovered',
  );
  const monitor = createPositionMonitor(definition.id, repository, logger);
  const candidates = strategy.decisions.flatMap((decision) =>
    decision.candidate ? [decision.candidate] : [],
  );
  let duplicates = 0,
    processed = 0;
  const outcomes: string[] = [];
  type Event = {
    at: string;
    candidate: BuyCandidate | null;
    observation: PaperReplay['observations'][number] | null;
  };
  const events: Event[] = [
    ...candidates.map((candidate) => ({
      at: candidate.timestamp,
      candidate,
      observation: null,
    })),
    ...replay.observations
      .filter((observation) => observation.side === 'SELL')
      .map((observation) => ({
        at: observation.receivedAt,
        candidate: null,
        observation,
      })),
  ].sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      (a.candidate
        ? -1
        : b.candidate
          ? 1
          : (a.observation?.id ?? '').localeCompare(b.observation?.id ?? '')),
  );
  try {
    for (const event of events) {
      if (signal?.aborted) break;
      const market = provider.market(
        event.candidate?.mint ?? event.observation!.mint,
        event.candidate?.poolAddress ?? event.observation!.poolAddress,
      );
      const risk = provider.riskAt(market, event.at);
      let result;
      if (event.candidate) {
        const candidate = event.candidate;
        const observation =
          replay.observations
            .filter(
              (item) =>
                item.side === 'BUY' &&
                item.mint === candidate.mint &&
                item.poolAddress === candidate.poolAddress &&
                Date.parse(item.receivedAt) <= Date.parse(event.at),
            )
            .sort(
              (a, b) =>
                Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
                a.id.localeCompare(b.id),
            )[0] ?? null;
        const command: PaperCommand = {
          type: 'ENTRY',
          id: stableId(['paper-entry-v1', definition.id, candidate.id]),
          at: event.at,
          candidate,
          risk,
          observation,
        };
        result = await repository.transact(
          definition.id,
          command,
          (state, account) => applyPaperCommand(state, command, account),
        );
        logger?.info(
          {
            portfolioId: definition.id,
            signalId: candidate.id,
            outcome: result.result.outcome,
            reasons: result.result.reasons,
            orderId: result.result.orderId,
            duplicate: result.duplicate,
          },
          'Paper entry processed',
        );
      } else result = await monitor.observe(event.observation!, risk, event.at);
      processed++;
      if (result.duplicate) duplicates++;
      outcomes.push(result.result.outcome);
    }
  } catch (error) {
    try {
      const latest = await repository.load(definition.id);
      const halt: PaperCommand = {
        type: 'HALT',
        id: stableId([
          'paper-processing-error',
          definition.id,
          processed,
          latest.state.asOf,
        ]),
        at: latest.state.asOf,
        reason: 'CRITICAL_PROCESSING_ERROR',
      };
      await repository.transact(definition.id, halt, (state, account) =>
        applyPaperCommand(state, halt, account),
      );
    } catch (haltError) {
      logger?.error(
        safeError(haltError),
        'Paper engine could not persist its halt; processing remains stopped',
      );
    }
    throw error;
  }
  const final = await recoverPortfolio(repository, definition.id);
  logger?.info(
    {
      portfolioId: definition.id,
      processed,
      duplicates,
      cashUsd: final.state.availableCashUsd,
      feesUsd: { buy: final.state.buyFeesUsd, sell: final.state.sellFeesUsd },
      realizedPnlUsd: final.state.realizedPnlUsd,
      equityUsd: final.state.equityUsd,
      status: final.state.status,
      positions: final.state.positions.map((position) => ({
        id: position.id,
        quantity: position.quantity,
        status: position.status,
      })),
    },
    'Paper replay completed',
  );
  return {
    definition,
    state: final.state,
    outcomes,
    processed,
    duplicates,
    eventCount: final.eventCount,
  };
}
