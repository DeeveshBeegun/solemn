import { config as loadDotEnv } from 'dotenv';
import { createDatabase, createScannerRepository } from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { createScannerService } from './scannerService.js';

loadDotEnv({ quiet: true });
const logger = createLogger('info');

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, SCANNER_ENABLED: 'true' });
  const secondsText = process.env.SCANNER_SMOKE_SECONDS ?? '20';
  if (
    !/^\d{1,2}$/.test(secondsText) ||
    Number(secondsText) < 5 ||
    Number(secondsText) > 60
  )
    throw new Error('SCANNER_SMOKE_SECONDS must be an integer from 5 to 60');
  const seconds = Number(secondsText);
  const database = createDatabase(config.DATABASE_URL);
  const scanner = createScannerService(
    config,
    createScannerRepository(database.db),
    logger,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => undefined;
  const onSignal = () => finish();
  const deadline = setTimeout(
    () => {
      logger.fatal(
        'Scanner smoke shutdown deadline exceeded; possible accepted event loss',
      );
      process.exit(1);
    },
    seconds * 1000 + config.SCANNER_DRAIN_TIMEOUT_MS + 15000,
  );
  try {
    await database.verify();
    logger.info(
      { durationSeconds: seconds },
      'Starting bounded, read-only scanner smoke test',
    );
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const window = new Promise<void>((resolve) => {
      finish = resolve;
      timer = setTimeout(resolve, seconds * 1000);
    });
    await scanner.start();
    await window;
    const metrics = scanner.metrics();
    logger.info(metrics, 'Scanner smoke observation complete');
    if (!metrics.subscriptionsReady) {
      logger.error(
        'Smoke test did not confirm all configured free subscriptions',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error(safeError(error), 'Scanner smoke test failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await scanner.stop();
    } catch (error) {
      logger.error(
        safeError(error),
        'Scanner smoke drain failed; possible data loss',
      );
      process.exitCode = 1;
    }
    await database.close();
    clearTimeout(deadline);
  }
}

void main().catch((error: unknown) => {
  // Configuration validators only expose field names/fixed messages.
  logger.fatal(
    error instanceof Error &&
      error.message.startsWith('Invalid Solemn configuration:')
      ? error.message
      : 'Scanner smoke bootstrap failed; check configuration',
  );
  process.exitCode = 1;
});
