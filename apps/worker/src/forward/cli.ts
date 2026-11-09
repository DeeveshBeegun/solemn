import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { createDatabase, createPaperRepository } from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { forwardPortfolioId } from './account.js';
import { runForwardCommand } from './forwardTradingService.js';
import {
  changeForwardControl,
  forwardPerformance,
  forwardStatus,
} from './monitor.js';

dotenv({ quiet: true });
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      'smoke-seconds': { type: 'string' },
      'backtest-run': { type: 'string' },
      reason: { type: 'string' },
    },
  });
  if (
    (values['smoke-seconds'] && action !== 'run') ||
    (values['backtest-run'] && action !== 'performance') ||
    (values.reason !== undefined &&
      action !== 'halt' &&
      action !== 'reset-halt')
  )
    throw new Error('Option does not apply to this command');
  const config = loadConfig(),
    logger = createLogger(config.LOG_LEVEL);
  let result: unknown;
  if (action === 'run') {
    const seconds =
      values['smoke-seconds'] === undefined
        ? undefined
        : Number(values['smoke-seconds']);
    if (
      seconds !== undefined &&
      (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
    )
      throw new Error('Smoke test must be 1–300 seconds');
    result = await runForwardCommand(config, logger, seconds);
  } else {
    const db = createDatabase(config.DATABASE_URL);
    try {
      if (action === 'status') result = await forwardStatus(db.db, config);
      else if (action === 'positions') {
        const { state } = await createPaperRepository(db.db).load(
          forwardPortfolioId(config),
        );
        result = state.positions.map((p) => ({
          ...p,
          unrealizedPnlUsd:
            p.valuationStale ||
            p.liquidationUncertain ||
            p.status === 'EXIT_BLOCKED'
              ? null
              : p.unrealizedPnlUsd,
        }));
      } else if (action === 'performance')
        result = await forwardPerformance(
          db.db,
          config,
          values['backtest-run'],
        );
      else if (action === 'rearm-metered') {
        const lease = await db.acquireForwardOwnership(
          forwardPortfolioId(config),
        );
        try {
          result = await changeForwardControl(lease.db, config, action);
        } finally {
          lease.release();
        }
      } else if (
        action === 'pause' ||
        action === 'resume' ||
        action === 'halt' ||
        action === 'reset-halt'
      )
        result = await changeForwardControl(
          db.db,
          config,
          action,
          values.reason,
        );
      else throw new Error('Unknown forward command');
    } finally {
      await db.close();
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('/forward/cli.js'))
  void main().catch((error: unknown) => {
    createLogger('info').error(
      safeError(error),
      'Forward command failed. Check configuration, migrations and portfolio status.',
    );
    process.exitCode = 1;
  });
