import { config as loadDotEnv } from 'dotenv';
import {
  createDatabase,
  createScannerRepository,
  createRiskRepository,
} from '@solemn/database';
import { loadConfig } from './config/index.js';
import { createLogger, safeError } from './services/logger.js';
import { createWorker } from './services/worker.js';
import { createScannerService } from './scanner/scannerService.js';
import { createRiskAnalysisService } from './analysis/riskAnalysisService.js';
import { createFreePaperDecisionService } from './portfolio/freePaperDecisions.js';
import { createPaperTradingService } from './portfolio/paperTradingService.js';
import { createStrategyService } from './strategy/strategyService.js';
import { runForwardCommand } from './forward/forwardTradingService.js';

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
  if (config.FORWARD_PAPER_ENABLED) {
    await runForwardCommand(config, logger);
    return;
  }
  const database = createDatabase(config.DATABASE_URL, (error) => {
    logger.error(safeError(error), 'Unexpected PostgreSQL pool error');
    process.exitCode = 1;
    void stop();
  });
  const risk = config.TOKEN_RISK_ANALYSIS_ENABLED
    ? createRiskAnalysisService(
        config,
        createRiskRepository(database.db),
        logger,
      )
    : undefined;
  const scanner = config.SCANNER_ENABLED
    ? createScannerService(
        config,
        createScannerRepository(database.db, {
          requestRiskAnalysis: config.TOKEN_RISK_ANALYSIS_ENABLED,
        }),
        logger,
        undefined,
        (event) =>
          risk?.notify(
            event.event.tokenMint,
            event.event.eventType === 'TOKEN_MIGRATED',
          ),
      )
    : undefined;
  const freePaper = config.LIVE_PAPER_DECISIONS_ENABLED
    ? createFreePaperDecisionService(config, database, logger)
    : undefined;
  const strategy = config.STRATEGY_ENABLED
    ? (freePaper ?? createStrategyService(config, database.db, logger))
    : undefined;
  const paper = config.PAPER_TRADING_ENABLED
    ? freePaper
      ? {
          get status() {
            return freePaper.status;
          },
          async start() {
            if (config.LIVE_PAPER_EXECUTION_ENABLED)
              logger.info(
                {
                  portfolioId: freePaper.portfolioId,
                  status: 'PAPER_SIMULATION',
                },
                'Free live paper executor started',
              );
            logger.info(
              { portfolioId: freePaper.portfolioId, status: freePaper.status },
              'Paper entry service uses the free live decision engine',
            );
          },
          async stop() {
            /* Strategy lifecycle owns and drains the shared decision engine. */
          },
        }
      : createPaperTradingService(config, database.db, logger)
    : undefined;
  const worker = createWorker(
    config,
    database,
    logger,
    scanner,
    risk,
    strategy,
    paper,
  );
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const deadline = setTimeout(
        () => {
          logger.fatal(
            'Solemn shutdown deadline exceeded; accepted scanner events may be lost',
          );
          process.exit(1);
        },
        config.SCANNER_DRAIN_TIMEOUT_MS +
          config.RISK_SHUTDOWN_TIMEOUT_MS +
          45_000,
      );
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
