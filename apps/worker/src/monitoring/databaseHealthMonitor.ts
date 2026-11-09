import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import type { Database } from '@solemn/database';

export async function checkDatabaseHealth(db: Database) {
  const start = performance.now();
  try {
    // Probe the columns required by the final order gate, alongside connectivity.
    await db.execute(
      sql`select f.operational_health, f.owner_pid, f.ops_version, a.kind, i.category
          from forward_accounts f
          left join operational_audit_events a on a.portfolio_id = f.portfolio_id
          left join operational_incidents i on i.portfolio_id = f.portfolio_id
          limit 0`,
    );
    return {
      status: 'HEALTHY' as const,
      queryMs: Math.round(performance.now() - start),
    };
  } catch {
    return { status: 'FAILED' as const, queryMs: null };
  }
}
