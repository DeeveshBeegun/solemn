import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import {
  createDatabase,
  createHistoryRepository,
  createBacktestRepository,
  createPaperRepository,
  createStrategyRepository,
  backtestScenarios,
} from '@solemn/database';
import {
  backtestOptionsSchema,
  idSchema,
  stableHash,
  stableId,
} from '@solemn/shared';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { readReplayFile } from '../strategy/replay.js';
import { createStressFixture } from './stressScenarios.js';
import {
  historyEvents,
  PostgresHistoricalDataProvider,
  validateHistoricalFile,
} from './historicalDataProvider.js';
import { generateScenarioReport, runScenarios } from './scenarioRunner.js';
import type { ScenarioName } from './scenarioRunner.js';
import { scenarioNames } from '../execution/simulation/executionScenarios.js';
dotenv({ quiet: true });
export function parseStressArguments(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      strategy: { type: 'string' },
      scenario: { type: 'string', default: 'all' },
      output: { type: 'string' },
      seed: { type: 'string', default: '42' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return null;
  const names: ScenarioName[] =
    values.scenario === 'all'
      ? [...scenarioNames, 'week6-reference']
      : (values.scenario?.split(',') as ScenarioName[]);
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((n) => ![...scenarioNames, 'week6-reference'].includes(n))
  )
    throw new Error('Invalid execution scenario');
  if (!/^(0|[1-9][0-9]*)$/.test(values.seed!))
    throw new Error('Seed must be a nonnegative integer');
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed) || seed > 2147483647)
    throw new Error('Invalid seed');
  const date = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
  const options = backtestOptionsSchema.parse({
    dataset: values.dataset ?? 'fixtures',
    ...(values.start ? { startTime: date(values.start) } : {}),
    ...(values.end ? { endTime: date(values.end) } : {}),
    ...(values.strategy ? { strategyId: values.strategy } : {}),
    ...(values.output ? { outputDirectory: values.output } : {}),
  });
  return { options, names, seed };
}
async function main() {
  const args = parseStressArguments(process.argv.slice(2));
  if (!args) {
    process.stdout.write(
      'pnpm backtest:stress --dataset fixtures --scenario all --seed 42 [--start ISO --end ISO --strategy SOLEMN_LAUNCH_MOMENTUM_V1 --output reports/backtests]\n',
    );
    return;
  }
  const config = loadConfig(),
    logger = createLogger(config.LOG_LEVEL),
    database = createDatabase(config.DATABASE_URL);
  try {
    const history = createHistoryRepository(database.db),
      name = args.options.dataset;
    if (name === 'real')
      throw new Error(
        'Verified historical pool reserves are unavailable. Supply a historical dataset file or postgres dataset ID.',
      );
    const dataset =
      name === 'fixtures'
        ? await history.register(
            createStressFixture(config).manifest,
            historyEvents(createStressFixture(config).events),
            args.options.batchSize,
            args.options.maxEvents,
          )
        : idSchema.safeParse(name.replace(/^postgres:/, '')).success
          ? await history.load(name.replace(/^postgres:/, ''))
          : await (async () => {
              const file = validateHistoricalFile(await readReplayFile(name));
              return history.register(
                file.manifest,
                historyEvents(file.events),
                args.options.batchSize,
                args.options.maxEvents,
              );
            })();
    const services = {
      paper: createPaperRepository(database.db),
      strategy: createStrategyRepository(database.db),
      backtests: createBacktestRepository(database.db),
    };
    const results = await runScenarios(
      new PostgresHistoricalDataProvider(dataset, history),
      config,
      services,
      args.options,
      args.names,
      args.seed,
      logger,
    );
    const report = await generateScenarioReport(
      results,
      services,
      args.options.outputDirectory,
      args.seed,
    );
    for (const result of results) {
      const name = result.plan.execution?.scenario ?? 'week6-reference';
      const record = {
        id: stableId(['execution-scenario-v1', report.experimentId, name]),
        experimentId: report.experimentId,
        runId: result.plan.runId,
        name,
        configuration: result.plan.execution ?? {
          modelVersion: 'WEEK6_REFERENCE' as const,
          seed: args.seed,
        },
      };
      await database.db
        .insert(backtestScenarios)
        .values(record)
        .onConflictDoNothing();
      const persisted = (
        await database.db
          .select()
          .from(backtestScenarios)
          .where(eq(backtestScenarios.id, record.id))
      )[0];
      if (
        !persisted ||
        persisted.runId !== record.runId ||
        stableHash(persisted.configuration) !== stableHash(record.configuration)
      )
        throw new Error('Scenario membership conflict');
      logger.debug(
        { scenario: name, configurationHash: stableHash(record.configuration) },
        'Scenario registered',
      );
    }
    logger.info(
      {
        experimentId: report.experimentId,
        directory: report.directory,
        scenarios: report.rows,
      },
      'Execution stress report generated',
    );
  } finally {
    await database.close();
  }
}
if (process.argv[1]?.endsWith('/backtesting/stressCli.js'))
  void main().catch((error: unknown) => {
    createLogger('info').error(
      safeError(error),
      'Execution stress test failed',
    );
    process.exitCode = 1;
  });
