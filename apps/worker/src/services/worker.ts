import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import { PaperExecutionAdapter } from '../execution/paper.js';

export interface DatabaseService {
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerScanner {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: string;
}

export function createWorker(
  config: Config,
  database: DatabaseService,
  logger: Logger,
  scanner?: WorkerScanner,
  riskAnalysis?: { start(): Promise<void>; stop(): Promise<void> },
  strategy?: {
    start(): Promise<void>;
    stop(): Promise<void>;
    readonly status: string;
  },
  paperTrading?: {
    start(): Promise<void>;
    stop(): Promise<void>;
    readonly status: string;
  },
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
            ...(config.PAPER_TRADING_ENABLED
              ? {
                  configuredInitialBalanceUsd: config.INITIAL_PAPER_BALANCE_USD,
                }
              : { initialBalanceUsd: execution.getBalanceUsd() }),
          },
          'PAPER services initialized',
        );
        if (config.TOKEN_RISK_ANALYSIS_ENABLED) {
          if (!riskAnalysis)
            throw new Error('Risk analysis enabled but no service provided');
          await riskAnalysis.start();
        }
        if (shutdown) return;
        if (config.SCANNER_ENABLED) {
          if (!scanner)
            throw new Error('Scanner enabled but no scanner service provided');
          await scanner.start();
        } else logger.info('Solemn scanner disabled');
        if (shutdown) return;
        if (config.STRATEGY_ENABLED) {
          if (!strategy)
            throw new Error('Strategy enabled but no service provided');
          await strategy.start();
        }
        if (shutdown) return;
        if (config.PAPER_TRADING_ENABLED) {
          if (!paperTrading)
            throw new Error('Paper trading enabled but no service provided');
          await paperTrading.start();
        }
        if (shutdown) return;
        keepAlive = setInterval(() => undefined, 60_000);
        logger.info(
          {
            scannerStatus: config.SCANNER_ENABLED
              ? scanner?.status
              : 'DISABLED',
            riskAnalysisEnabled: config.TOKEN_RISK_ANALYSIS_ENABLED,
            paperTradingStatus: config.PAPER_TRADING_ENABLED
              ? paperTrading?.status
              : 'DISABLED',
            strategyStatus: config.STRATEGY_ENABLED
              ? strategy?.status
              : 'DISABLED',
          },
          'Solemn worker ready',
        );
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
        try {
          try {
            try {
              if (config.PAPER_TRADING_ENABLED) await paperTrading?.stop();
            } finally {
              if (config.STRATEGY_ENABLED) await strategy?.stop();
            }
          } finally {
            if (config.SCANNER_ENABLED) await scanner?.stop();
          }
        } finally {
          try {
            if (config.TOKEN_RISK_ANALYSIS_ENABLED) await riskAnalysis?.stop();
          } finally {
            await database.close();
            logger.info('Solemn worker stopped');
          }
        }
      })();
      return shutdown;
    },
  };
}
