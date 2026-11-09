import { config as loadDotEnv } from 'dotenv';
import { createDatabase, createPaperRepository } from '@solemn/database';
import { idSchema, stableId } from '@solemn/shared';
import type { PaperCommand } from '@solemn/shared';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { applyPaperCommand } from './portfolioManager.js';
import { recoverPortfolio } from './recovery.js';
loadDotEnv({ quiet: true });
const logger = createLogger('info');
async function main() {
  const action = process.argv[2],
    portfolioId = idSchema.parse(process.argv[3]);
  if (!['inspect', 'reset', 'halt'].includes(action ?? ''))
    throw new Error('Expected inspect, reset or halt action');
  const config = loadConfig(),
    database = createDatabase(config.DATABASE_URL),
    repository = createPaperRepository(database.db);
  try {
    const recovered = await recoverPortfolio(repository, portfolioId);
    if (action !== 'inspect') {
      if (recovered.definition.dataMode !== 'FIXTURE')
        throw new Error('Use the forward portfolio administrative commands');
      const reason = process.argv[4]?.replace(/^--reason=/, '');
      if (!reason)
        throw new Error('An explicit administrative reason is required');
      const at = new Date().toISOString();
      const command: PaperCommand = {
        type: action === 'reset' ? 'RESET_HALT' : 'HALT',
        id: stableId(['paper-admin', portfolioId, action, at, reason]),
        at,
        reason,
      };
      const result = await repository.transact(
        portfolioId,
        command,
        (state, definition) => applyPaperCommand(state, command, definition),
      );
      logger.info(
        { portfolioId, ...result.result, status: result.state.status },
        'Paper administrative action recorded',
      );
    } else {
      const history = await repository.history(portfolioId);
      logger.info(
        {
          definition: recovered.definition,
          state: recovered.state,
          eventCount: recovered.eventCount,
          orders: history
            .flatMap((event) => event.orders)
            .map((record) => ({
              orderId: record.order.id,
              side: record.order.side,
              status: record.order.status,
              quantity: record.order.requestedQuantity,
              fill: record.trades[0] ?? null,
              notionalUsd: record.notionalUsd,
              reason: record.reason,
              failureReason: record.failureReason,
            })),
        },
        'Paper portfolio and audited order history',
      );
    }
  } finally {
    await database.close();
  }
}
void main().catch((error: unknown) => {
  logger.error(safeError(error), 'Paper portfolio action failed');
  process.exitCode = 1;
});
