import { createDatabase, ForwardOwnershipConflict } from '@solemn/database';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { safeError } from '../services/logger.js';
import { forwardPortfolioId, lockForwardAccount } from './account.js';
import { runLiveForward } from './liveProvider.js';
import { runForwardReplay } from './replayCoordinator.js';
import { engageKillSwitch } from '../operations/killSwitch.js';
import { assertPaperMode } from '../security/securityPolicy.js';
import { createReplayProvider } from './replayProvider.js';

export async function runForwardCommand(
  config: Config,
  logger: Logger,
  smokeSeconds?: number,
) {
  assertPaperMode(config);
  if (!config.FORWARD_PAPER_ENABLED)
    throw new Error(
      'Set FORWARD_PAPER_ENABLED=true to start forward paper trading',
    );
  if (
    smokeSeconds !== undefined &&
    (config.FORWARD_MARKET_DATA_MODE !== 'LIVE_READ_ONLY' ||
      config.ENABLE_METERED_MARKET_DATA)
  )
    throw new Error(
      'Bounded smoke testing requires live read-only mode with metered data disabled',
    );
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const db = createDatabase(config.DATABASE_URL, (error) => {
    logger.error(safeError(error), 'Forward database connection failed');
    controller.abort(error);
  });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timer =
    smokeSeconds === undefined
      ? undefined
      : setTimeout(onSignal, smokeSeconds * 1000);
  try {
    await db.verify();
    const id = forwardPortfolioId(config);
    const lease = await db
      .acquireForwardOwnership(id)
      .catch(async (error: unknown) => {
        if (error instanceof ForwardOwnershipConflict) {
          logger.error(
            { portfolioId: id, reason: 'DUPLICATE_WORKER_DETECTED' },
            'Forward ownership conflict',
          );
          await db.db
            .transaction(async (tx) => {
              const row = await lockForwardAccount(tx, id);
              await engageKillSwitch(
                tx,
                row,
                'DUPLICATE_WORKER_DETECTED',
                'worker',
                'OWNERSHIP',
              );
            })
            .catch(() =>
              logger.error(
                { portfolioId: id },
                'Ownership conflict halt could not be durably audited',
              ),
            );
        }
        throw error;
      });
    try {
      const signal = AbortSignal.any([controller.signal, lease.signal]);
      const result =
        config.FORWARD_MARKET_DATA_MODE === 'REPLAY'
          ? await runForwardReplay(
              lease.db,
              config,
              createReplayProvider(config),
              logger,
              signal,
            )
          : await runLiveForward(lease.db, db.db, config, logger, signal);
      if (lease.signal.aborted)
        throw new Error('Forward database ownership connection was lost');
      if (
        controller.signal.reason instanceof Error &&
        controller.signal.reason.name !== 'AbortError'
      )
        throw controller.signal.reason;
      logger.info(
        {
          portfolioId: result.portfolioId,
          sessionId: result.sessionId,
          mode: config.FORWARD_MARKET_DATA_MODE,
        },
        'Forward session stopped',
      );
      return result;
    } finally {
      lease.release();
    }
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await db.close();
  }
}
