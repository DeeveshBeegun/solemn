import { config as loadDotEnv } from 'dotenv';
import { createDatabase } from '@solemn/database';
import { loadConfig } from './config/index.js';
import { createLogger, safeError } from './services/logger.js';
import { createWorker } from './services/worker.js';

loadDotEnv({ quiet: true });
const bootstrapLogger = createLogger('info');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    bootstrapLogger.fatal(
      error instanceof Error ? error.message : 'Invalid Solemn configuration',
    );
    process.exitCode = 1;
    return;
  }
  const logger = createLogger(config.LOG_LEVEL);
  const database = createDatabase(config.DATABASE_URL, (error) => {
    logger.error(safeError(error), 'Unexpected PostgreSQL pool error');
    process.exitCode = 1;
    void stop();
  });
  const worker = createWorker(config, database, logger);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const deadline = setTimeout(() => {
        logger.fatal('Solemn shutdown exceeded 10 seconds');
        process.exit(1);
      }, 10_000);
      try {
        await worker.stop();
      } catch (error) {
        logger.error(safeError(error), 'Solemn shutdown failed');
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('uncaughtException', onUnexpectedError);
        process.removeListener('unhandledRejection', onUnexpectedError);
        logger.flush();
      }
    })();
    return stopping;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'Solemn shutdown requested');
    void stop();
  };
  const onUnexpectedError = (error: unknown) => {
    logger.fatal(safeError(error), 'Unexpected Solemn error');
    process.exitCode = 1;
    void stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', onUnexpectedError);
  process.on('unhandledRejection', onUnexpectedError);
  try {
    await worker.start();
  } catch (error) {
    logger.fatal(
      safeError(error),
      'Solemn startup failed; check PostgreSQL availability',
    );
    process.exitCode = 1;
    await stop();
  }
}

void main().catch(() => {
  bootstrapLogger.fatal('Solemn bootstrap failed');
  process.exitCode = 1;
});
