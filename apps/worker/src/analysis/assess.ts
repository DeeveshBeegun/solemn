import { randomUUID } from 'node:crypto';
import { config as loadDotEnv } from 'dotenv';
import { createDatabase, createRiskRepository } from '@solemn/database';
import { mintAddressSchema } from '@solemn/shared';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { createRiskAnalysisService } from './riskAnalysisService.js';

loadDotEnv({ quiet: true });
const logger = createLogger('info');
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 1 || !mintAddressSchema.safeParse(args[0]).success) {
    logger.error(
      'Usage: pnpm risk:assess <SOLANA_MINT> (one bounded read-only assessment)',
    );
    process.exitCode = 1;
    return;
  }
  const mint = mintAddressSchema.parse(args[0]);
  const config = loadConfig({
    ...process.env,
    TOKEN_RISK_ANALYSIS_ENABLED: 'true',
  });
  const database = createDatabase(config.DATABASE_URL);
  const repository = createRiskRepository(database.db);
  const service = createRiskAnalysisService(config, repository, logger);
  const deadline = setTimeout(() => {
    logger.fatal(
      'Bounded risk assessment deadline exceeded; work remains UNKNOWN/recoverable',
    );
    process.exit(1);
  }, 120000);
  const stop = () => {
    void service.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await database.verify();
    await repository.request(mint, randomUUID(), new Date().toISOString());
    await service.runOnce(mint);
    logger.info(
      { mint, ...service.metrics() },
      'Bounded risk assessment complete; inspect token_risk_assessments for evidence',
    );
  } catch (error) {
    logger.error(safeError(error), 'Bounded risk assessment failed');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      await service.stop();
    } finally {
      await database.close();
      clearTimeout(deadline);
    }
  }
}
void main().catch((error: unknown) => {
  logger.fatal(
    error instanceof Error &&
      error.message.startsWith('Invalid Solemn configuration:')
      ? error.message
      : 'Risk assessment bootstrap failed',
  );
  process.exitCode = 1;
});
