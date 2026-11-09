import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { ForwardOwnershipConflict } from './forwardOwnership.js';
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
    async acquireForwardOwnership(portfolioId: string) {
      const connection = await pool.connect();
      try {
        const result = await connection.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(hashtextextended($1, 8)) as locked',
          [portfolioId],
        );
        if (!result.rows[0]?.locked) throw new ForwardOwnershipConflict();
      } catch (error) {
        connection.release(true);
        throw error;
      }
      // All forward writes use the connection holding the advisory lock. Losing it fences the worker.
      const lost = new AbortController();
      const onError = () => lost.abort();
      connection.on('error', onError);
      return {
        db: drizzle(connection, { schema }),
        signal: lost.signal,
        release: () => {
          connection.removeListener('error', onError);
          connection.release(true);
        },
      };
    },
    async verify() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

export type Database = NodePgDatabase<typeof schema>;
