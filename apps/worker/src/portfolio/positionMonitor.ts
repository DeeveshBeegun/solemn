import { stableId } from '@solemn/shared';
import type { ExecutionObservation, StrategyRiskContext } from '@solemn/shared';
import type { PaperRepository } from '@solemn/database';
import type { Logger } from 'pino';
import { applyPaperCommand } from './portfolioManager.js';
export function createPositionMonitor(
  portfolioId: string,
  repository: PaperRepository,
  logger?: Logger,
) {
  return {
    async observe(
      observation: ExecutionObservation,
      risk: StrategyRiskContext | null,
      at = observation.receivedAt,
    ) {
      const command = {
        type: 'MARK' as const,
        id: stableId(['paper-mark-v1', portfolioId, observation.id]),
        at,
        observation,
        risk,
      };
      const committed = await repository.transact(
        portfolioId,
        command,
        (state, definition) => applyPaperCommand(state, command, definition),
      );
      logger?.info(
        {
          portfolioId,
          mint: observation.mint,
          orderId: committed.result.orderId,
          outcome: committed.result.outcome,
          reasons: committed.result.reasons,
          duplicate: committed.duplicate,
          status: committed.state.status,
          entryBlockReasons: committed.state.entryBlockReasons,
          haltReason: committed.state.haltReason,
        },
        'Paper position observation processed',
      );
      if (
        !committed.duplicate &&
        committed.state.entryBlockReasons.includes('DAILY_LOSS_LIMIT')
      )
        logger?.warn(
          { portfolioId, dailyLossPercent: committed.state.dailyLossPercent },
          'Paper daily loss threshold reached; new entries disabled',
        );
      if (!committed.duplicate && committed.state.status === 'HALTED')
        logger?.warn(
          { portfolioId, reason: committed.state.haltReason },
          'Paper portfolio halted; protective exits remain enabled',
        );
      return committed;
    },
    async tick(at: string) {
      const command = {
        type: 'TICK' as const,
        id: stableId(['paper-tick-v1', portfolioId, at]),
        at,
      };
      return repository.transact(portfolioId, command, (state, definition) =>
        applyPaperCommand(state, command, definition),
      );
    },
  };
}
