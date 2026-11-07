import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createDatabase(
  databaseUrl: string,
  onIdleError: (error: Error) => void = () => undefined,
) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    options: '-c timezone=UTC',
  });
  pool.on('error', onIdleError);
  return {
    db: drizzle(pool, { schema }),
    pool,
    async verify() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

export type Database = NodePgDatabase<typeof schema>;
