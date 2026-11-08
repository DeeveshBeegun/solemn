import { config as loadDotEnv } from 'dotenv';
import {
  createDatabase,
  createPaperRepository,
  createStrategyRepository,
} from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { readReplayFile } from '../strategy/replay.js';
import { replayPaperTrading } from './paperReplay.js';
import { createPaperReplayFixture } from './replayFixture.js';
loadDotEnv({ quiet: true });
const logger = createLogger('info');
async function main() {
  // Invoking this replay-only command is explicit fixture opt-in; worker startup is separate.
  const config = { ...loadConfig(), PAPER_ALLOW_FIXTURE_SIGNALS: true },
    database = createDatabase(config.DATABASE_URL);
  try {
    await database.verify();
    const argument = process.argv[2],
      scenario =
        argument === '--scenario=blocked-stop'
          ? 'blocked-stop'
          : 'profit-targets';
    if (
      argument?.startsWith('--') &&
      argument !== '--scenario=blocked-stop' &&
      argument !== '--scenario=profit-targets'
    )
      throw new Error('Unknown replay option');
    const input =
      argument && !argument.startsWith('--')
        ? await readReplayFile(argument)
        : createPaperReplayFixture(config, scenario);
    await replayPaperTrading(
      input,
      config,
      createStrategyRepository(database.db),
      createPaperRepository(database.db),
      logger,
    );
  } finally {
    await database.close();
  }
}
void main().catch((error: unknown) => {
  logger.error(safeError(error), 'Paper replay failed');
  process.exitCode = 1;
});
