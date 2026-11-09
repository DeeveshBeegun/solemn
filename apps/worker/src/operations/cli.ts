import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  createDatabase,
  operationalAuditEvents,
  operationalIncidents,
} from '@solemn/database';
import { loadConfig } from '../config/index.js';
import { forwardPortfolioId } from '../forward/account.js';
import { forwardStatus } from '../forward/monitor.js';
import { checkDatabaseHealth } from '../monitoring/databaseHealthMonitor.js';
import { createLogger, safeError } from '../services/logger.js';
import { changeOperationalControl } from './adminControls.js';
import { reconcileForwardLedger } from './portfolioReconciler.js';

dotenv({ quiet: true });
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      reason: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'pnpm solemn:{status,health,incidents,reconcile,pause,resume,halt,reset-halt} [--reason TEXT]\n',
    );
    return;
  }
  if (
    values.reason !== undefined &&
    action !== 'halt' &&
    action !== 'reset-halt'
  )
    throw new Error('Reason is only accepted for halt and reset');
  const config = loadConfig(),
    db = createDatabase(config.DATABASE_URL);
  const id = forwardPortfolioId(config);
  const output = (value: unknown) =>
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  try {
    if (
      action === 'pause' ||
      action === 'resume' ||
      action === 'halt' ||
      action === 'reset-halt'
    ) {
      output(
        await changeOperationalControl(db.db, config, action, values.reason),
      );
    } else if (action === 'incidents') {
      const [incidents, audit] = await Promise.all([
        db.db
          .select()
          .from(operationalIncidents)
          .where(eq(operationalIncidents.portfolioId, id))
          .orderBy(
            desc(operationalIncidents.openedAt),
            desc(operationalIncidents.id),
          )
          .limit(100),
        db.db
          .select()
          .from(operationalAuditEvents)
          .where(eq(operationalAuditEvents.portfolioId, id))
          .orderBy(
            desc(operationalAuditEvents.at),
            desc(operationalAuditEvents.id),
          )
          .limit(100),
      ]);
      output({ portfolioId: id, incidents, audit, limit: 100 });
    } else if (action === 'reconcile') {
      try {
        const { state, eventCount, orders, fills } =
          await reconcileForwardLedger(db.db, id);
        output({
          portfolioId: id,
          reconciliation: 'PASS',
          eventCount,
          orders,
          fills,
          state,
        });
      } catch (error) {
        output({
          portfolioId: id,
          reconciliation: 'FAIL',
          ...safeError(error),
        });
        process.exitCode = 1;
      }
    } else if (action === 'status' || action === 'health') {
      const database = await checkDatabaseHealth(db.db);
      if (database.status === 'FAILED') {
        output({
          portfolioId: id,
          status: 'UNKNOWN',
          database,
          newEntries: false,
          protectiveExits: false,
        });
        process.exitCode = 1;
        return;
      }
      const [status, activeIncidents] = await Promise.all([
        forwardStatus(db.db, config),
        db.db
          .select()
          .from(operationalIncidents)
          .where(
            and(
              eq(operationalIncidents.portfolioId, id),
              isNull(operationalIncidents.resolvedAt),
            ),
          )
          .limit(100),
      ]);
      output({ ...status, database, activeIncidents });
    } else throw new Error('Unknown operations action');
  } finally {
    await db.close();
  }
}
if (process.argv[1]?.endsWith('/operations/cli.js'))
  void main().catch((error: unknown) => {
    createLogger('info').error(
      safeError(error),
      'Operational command failed. Check current state, required reason and recovery prerequisites.',
    );
    process.exitCode = 1;
  });
