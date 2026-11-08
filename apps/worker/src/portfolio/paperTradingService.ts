import {
  createPaperRepository,
  createStrategyRepository,
} from '@solemn/database';
import type { Database } from '@solemn/database';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';
import { readReplayFile } from '../strategy/replay.js';
import { replayPaperTrading } from './paperReplay.js';
import { recoverPortfolio } from './recovery.js';
export function createPaperTradingService(
  config: Config,
  db: Database,
  logger: Logger,
) {
  const controller = new AbortController();
  let running: Promise<void> | undefined,
    started = false,
    stopped = false,
    status = 'DISABLED';
  return {
    get status() {
      return status;
    },
    async start() {
      if (started || stopped) return;
      started = true;
      status =
        config.PAPER_REPLAY_PATH && config.PAPER_ALLOW_FIXTURE_SIGNALS
          ? 'REPLAY'
          : 'NOT_READY';
      logger.info(
        { status, mode: 'PAPER', liveTransactions: false },
        'Paper trading engine started',
      );
      if (config.PAPER_PORTFOLIO_ID && status === 'NOT_READY') {
        const recovered = await recoverPortfolio(
          createPaperRepository(db),
          config.PAPER_PORTFOLIO_ID,
        );
        logger.info(
          {
            portfolioId: recovered.state.id,
            status: recovered.state.status,
            positions: recovered.state.positions.filter(
              (position) => position.status !== 'CLOSED',
            ).length,
          },
          'Paper position recovery completed',
        );
      }
      if (status === 'NOT_READY') {
        logger.warn(
          'Forward paper trading NOT_READY; an explicit fixture replay and opt-in are required',
        );
        return;
      }
      running = (async () => {
        const input = await readReplayFile(config.PAPER_REPLAY_PATH);
        if (!stopped)
          await replayPaperTrading(
            input,
            config,
            createStrategyRepository(db),
            createPaperRepository(db),
            logger,
            controller.signal,
          );
        status = stopped ? 'STOPPED' : 'REPLAY_COMPLETE';
      })().catch((error: unknown) => {
        status = 'ERROR';
        logger.error(
          safeError(error),
          'Paper trading stopped after a critical processing error; entries disabled',
        );
      });
    },
    async stop() {
      stopped = true;
      controller.abort();
      await running;
      status = 'STOPPED';
    },
  };
}
