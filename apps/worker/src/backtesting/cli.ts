import { createAnalyticsFixture } from './analyticsFixture.js';
import { executionScenario } from '../execution/simulation/executionScenarios.js';
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { config as dotenv } from 'dotenv';
import {
  createDatabase,
  createHistoryRepository,
  createBacktestRepository,
  createPaperRepository,
  createStrategyRepository,
} from '@solemn/database';
import { idSchema } from '@solemn/shared';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { readReplayFile } from '../strategy/replay.js';
import { parseBacktestOptions, createBacktestPlan } from './backtestConfig.js';
import { createBacktestFixture } from './replayFixture.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
  validateHistoricalFile,
} from './historicalDataProvider.js';
import { auditOperationalHistory } from './dataAudit.js';
import { runBacktest } from './replayEngine.js';
import { generateBacktestReport } from './reportGenerator.js';
dotenv({ quiet: true });
const bootstrap = createLogger('info');
export async function parseBacktestArguments(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      strategy: { type: 'string' },
      'initial-balance': { type: 'string' },
      'output-dir': { type: 'string' },
      config: { type: 'string' },
      verbose: { type: 'boolean' },
      'latency-ms': { type: 'string' },
      'wait-ms': { type: 'string' },
      'equity-cadence-ms': { type: 'string' },
      'batch-size': { type: 'string' },
      'max-events': { type: 'string' },
      'run-id': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return null;
  let file: Record<string, unknown> = {};
  if (values.config) {
    const input = await readReplayFile(values.config);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Backtest configuration must be an object');
    file = input as Record<string, unknown>;
  }
  const overrides: Record<string, unknown> = {};
  for (const [argument, field] of [
    ['dataset', 'dataset'],
    ['strategy', 'strategyId'],
    ['initial-balance', 'initialBalanceUsd'],
    ['output-dir', 'outputDirectory'],
    ['run-id', 'runId'],
  ] as const)
    if (values[argument] !== undefined) overrides[field] = values[argument];
  const date = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  if (values.start) overrides.startTime = date(values.start);
  if (values.end) overrides.endTime = date(values.end);
  if (values.verbose !== undefined) overrides.verbose = values.verbose;
  for (const [argument, field] of [
    ['latency-ms', 'executionLatencyMs'],
    ['wait-ms', 'executionWaitMs'],
    ['equity-cadence-ms', 'equityCadenceMs'],
    ['batch-size', 'batchSize'],
    ['max-events', 'maxEvents'],
  ] as const)
    if (values[argument] !== undefined) {
      if (!/^\d+$/.test(values[argument]!))
        throw new Error(
          'Backtest numeric options must be nonnegative integers',
        );
      overrides[field] = Number(values[argument]);
    }
  return parseBacktestOptions({ ...file, ...overrides });
}
async function main() {
  const options = await parseBacktestArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'pnpm backtest --dataset fixtures|fixtures-winner|fixtures-zero-trade|historical|DATASET_UUID|FILE.json [--start ISO] [--end ISO] [--initial-balance 100] [--latency-ms 1000] [--wait-ms 30000] [--output-dir reports/backtests] [--config FILE.json] [--verbose]',
    );
    return;
  }
  const config = loadConfig(),
    logger = createLogger(options.verbose ? 'debug' : 'info'),
    database = createDatabase(config.DATABASE_URL);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await database.verify();
    if (options.dataset === 'historical') {
      const audit = await auditOperationalHistory(database.db),
        directory = resolve(options.outputDirectory, 'historical-data-audit');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'audit.json'),
        JSON.stringify(audit, null, 2) + '\n',
      );
      await writeFile(
        join(directory, 'report.md'),
        `# Solemn real historical data audit\n\nReadiness: **INSUFFICIENT**. No backtest was run and no synthetic fallback was used.\n\n${audit.limitations.map((item) => `- ${item}`).join('\n')}\n\nSee [the detailed data inventory](audit.json) for counts, missing timestamps, source classifications and observation ranges.\n`,
      );
      logger.error(
        {
          code: 'HISTORICAL_DATA_INSUFFICIENT',
          directory,
          summary: audit.summary,
        },
        'Real historical observations are insufficient; no backtest was run',
      );
      process.exitCode = 2;
      return;
    }
    const history = createHistoryRepository(database.db);
    let dataset;
    if (options.dataset.startsWith('fixtures')) {
      if (
        ![
          'fixtures',
          'fixtures-winner',
          'fixtures-zero-trade',
          'fixtures-analytics',
        ].includes(options.dataset)
      )
        throw new Error('Unknown fixture dataset');
      const file =
        options.dataset === 'fixtures-analytics'
          ? createAnalyticsFixture(config)
          : createBacktestFixture(
              config,
              options.dataset === 'fixtures-winner'
                ? 'winner'
                : options.dataset === 'fixtures-zero-trade'
                  ? 'zero-trade'
                  : 'all',
            );
      dataset = await history.register(
        file.manifest,
        historyEvents(file.events),
        options.batchSize,
        options.maxEvents,
      );
    } else if (
      idSchema.safeParse(options.dataset.replace(/^postgres:/, '')).success
    )
      dataset = await history.load(options.dataset.replace(/^postgres:/, ''));
    else {
      const file = validateHistoricalFile(
        await readReplayFile(options.dataset),
      );
      dataset = await history.register(
        file.manifest,
        historyEvents(file.events),
        options.batchSize,
        options.maxEvents,
      );
    }
    const plan = createBacktestPlan(
        options.dataset === 'fixtures-analytics' && !options.execution
          ? { ...options, execution: executionScenario('baseline') }
          : options,
        dataset,
        config,
      ),
      backtests = createBacktestRepository(database.db);
    logger.info(
      {
        runId: plan.runId,
        datasetId: dataset.id,
        sourceKind: dataset.manifest.sourceKind,
        quality: dataset.quality,
      },
      'Backtest dataset loaded',
    );
    const result = await runBacktest(
      plan,
      new PostgresHistoricalDataProvider(dataset, history),
      config,
      {
        paper: createPaperRepository(database.db),
        strategy: createStrategyRepository(database.db),
        backtests,
      },
      logger,
      controller.signal,
    );
    const directory = await generateBacktestReport(
      result,
      backtests,
      options.outputDirectory,
    );
    logger.info(
      {
        runId: plan.runId,
        directory,
        closedPositions: result.metrics.trading.closedPositions,
        openPositions: result.metrics.strategy.positionsRemainingOpen,
        realizedNetPnlUsd: result.metrics.portfolio.realizedNetPnlUsd,
        endingReliableEquityUsd: result.metrics.portfolio.endingMarkedEquityUsd,
      },
      'Backtest report generated',
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database.close();
  }
}
// Keep argument parsing independently testable without starting a database connection.
if (process.argv[1]?.endsWith('/backtesting/cli.js'))
  void main().catch((error: unknown) => {
    bootstrap.error(
      safeError(error),
      'Backtest failed; check dataset availability, validated options and database migrations',
    );
    process.exitCode = 1;
  });
