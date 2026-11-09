import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

export class ForwardOwnershipConflict extends Error {
  constructor() {
    super('Another forward worker owns this paper portfolio');
  }
}

/** Check the exact bigint advisory lock, scoped to the recorded PostgreSQL backend. */
export async function forwardOwnerPid(
  db: Database,
  portfolioId: string,
  backendPid?: number,
) {
  const result = await db.execute<{ pid: number }>(sql`
    select pid from pg_locks
    where locktype = 'advisory' and mode = 'ExclusiveLock' and granted
      and database = (select oid from pg_database where datname = current_database())
      and pid = ${backendPid === undefined ? sql`pg_backend_pid()` : sql`${backendPid}::int`}
      and objsubid = 1
      and classid::bigint = ((hashtextextended(${portfolioId}, 8) >> 32) & 4294967295)
      and objid::bigint = (hashtextextended(${portfolioId}, 8) & 4294967295)
  `);
  return result.rows[0]?.pid ?? null;
}
