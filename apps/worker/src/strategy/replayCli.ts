import { config as loadDotEnv } from 'dotenv';
import { createDatabase, createStrategyRepository } from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { createReplayFixture } from './replayFixture.js';
import { readReplayFile, replayStrategy } from './replay.js';
loadDotEnv({ quiet: true });
const logger = createLogger('info');
async function main() {
  const config = loadConfig(),
    database = createDatabase(config.DATABASE_URL);
  try {
    await database.verify();
    const path = process.argv[2] ?? config.STRATEGY_FIXTURE_PATH;
    const result = await replayStrategy(
      path ? await readReplayFile(path) : createReplayFixture(config),
      config,
      createStrategyRepository(database.db),
      logger,
    );
    logger.info(
      {
        runId: result.run.id,
        candidates: result.decisions.flatMap((decision) =>
          decision.candidate ? [decision.candidate] : [],
        ),
      },
      'Synthetic research BUY candidates (no orders)',
    );
  } finally {
    await database.close();
  }
}
void main().catch((error: unknown) => {
  logger.error(safeError(error), 'Strategy replay failed');
  process.exitCode = 1;
});
