import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { PaperExecutionAdapter } from '../execution/paper.js';

export interface DatabaseService {
  verify(): Promise<void>;
  close(): Promise<void>;
}

export function createWorker(
  config: Config,
  database: DatabaseService,
  logger: Logger,
) {
  // No fixtures are provided at startup: the worker cannot simulate unsolicited fills.
  const execution = new PaperExecutionAdapter(config.INITIAL_PAPER_BALANCE_USD);
  let startup: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  return {
    execution,
    start(): Promise<void> {
      if (shutdown)
        return Promise.reject(new Error('Worker has already been stopped'));
      startup ??= (async () => {
        logger.info('Solemn starting');
        logger.info('Environment configuration validated');
        await database.verify();
        logger.info('PostgreSQL connection established');
        if (shutdown) return;
        logger.info(
          {
            tradingMode: config.TRADING_MODE,
            initialBalanceUsd: execution.getBalanceUsd(),
          },
          'PAPER services initialized',
        );
        keepAlive = setInterval(() => undefined, 60_000);
        logger.info('Solemn worker ready');
      })();
      return startup;
    },
    stop(): Promise<void> {
      shutdown ??= (async () => {
        // Wait for in-flight startup before closing the connection it is using.
        try {
          await startup;
        } catch {
          /* Startup failure is reported by the caller. */
        }
        if (keepAlive) clearInterval(keepAlive);
        await database.close();
        logger.info('Solemn worker stopped');
      })();
      return shutdown;
    },
  };
}
