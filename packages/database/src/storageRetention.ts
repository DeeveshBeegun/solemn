import type { Pool, PoolClient } from 'pg';

const maintenanceLock = 'solemn-database-storage-retention-v1';
const tables = [
  'backtest_dataset_events',
  'backtest_datasets',
  'backtest_equity_snapshots',
  'backtest_execution_intents',
  'backtest_results',
  'backtest_runs',
  'backtest_scenarios',
  'execution_simulation_attempts',
  'forward_accounts',
  'forward_runtime_events',
  'market_candles',
  'market_corrections',
  'market_coverage_observations',
  'market_events',
  'market_snapshots',
  'market_trade_observations',
  'operational_audit_events',
  'operational_incidents',
  'orders',
  'paper_portfolios',
  'portfolio_balance_events',
  'positions',
  'scanner_gaps',
  'strategy_decisions',
  'strategy_evaluation_periods',
  'strategy_evaluations',
  'strategy_runs',
  'swap_execution_assessments',
  'trades',
  'token_risk_assessments',
  'tokens',
] as const;
type RetentionTable = (typeof tables)[number];
type Policy = {
  limit_bytes: string;
  target_bytes: string;
  cleanup_active: boolean;
  pending_tables: string[];
  deleted_rows: string;
};
type Candidate = {
  kind: 'portfolio' | 'dataset' | 'market' | 'gap' | 'snapshot' | 'token';
  id: string;
};
export type StorageRetentionResult = {
  status:
    | 'BELOW_LIMIT'
    | 'CLEANED'
    | 'NO_ELIGIBLE_DATA'
    | 'MORE_WORK'
    | 'BUSY'
    | 'NOT_MIGRATED';
  usedBytes: string;
  deletedRows: number;
};

// Keep token metadata while any retained evidence or active risk request uses it.
const unusedToken = `
  greatest(t.discovered_at, coalesce(t.migration_observed_at,t.discovered_at),
    coalesce(t.risk_requested_at,t.discovered_at), coalesce(t.risk_assessed_at,t.discovered_at))
    < now()-interval '1 day'
  AND coalesce(t.risk_lease_until,'-infinity'::timestamptz)<now()
  AND coalesce(t.risk_valid_until,'-infinity'::timestamptz)<now()
  AND NOT EXISTS (SELECT 1 FROM market_events x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM market_snapshots x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM positions x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM trades x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM trading_signals x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM strategy_decisions x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM market_trade_observations x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM market_coverage_observations x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM market_candles x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM market_corrections x WHERE x.token_mint=t.mint_address)
  AND NOT EXISTS (SELECT 1 FROM backtest_dataset_events x WHERE x.mint=t.mint_address)
`;

async function usage(client: PoolClient) {
  const result = await client.query<{ bytes: string }>(
    'SELECT pg_database_size(current_database())::text AS bytes',
  );
  return result.rows[0]!.bytes;
}

async function policy(client: PoolClient) {
  const result = await client.query<Policy>(
    'SELECT limit_bytes, target_bytes, cleanup_active, pending_tables, deleted_rows FROM public.solemn_storage_policy WHERE singleton',
  );
  if (!result.rows[0]) throw new Error('Solemn storage policy is missing');
  return result.rows[0];
}

/** Delete one old, inactive bundle atomically and persist the space-reclamation queue. */
async function pruneBatch(client: PoolClient) {
  const touched = new Set<RetentionTable>();
  let deleted = 0;
  const remove = async (
    table: RetentionTable,
    condition: string,
    values: unknown[],
  ) => {
    const result = await client.query(
      'DELETE FROM public."' + table + '" WHERE ' + condition,
      values,
    );
    if (result.rowCount) {
      touched.add(table);
      deleted += result.rowCount;
    }
  };
  await client.query('BEGIN');
  try {
    // These locks fence account mutations and keep the temporary immutable-trigger
    // changes invisible to other sessions. A busy database retries on the next pass.
    await client.query(
      'LOCK TABLE ' +
        tables.map((table) => 'public."' + table + '"').join(', ') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    const candidates = await client.query<Candidate>(`
      SELECT kind, id FROM (
        SELECT 'portfolio' AS kind, p.id::text AS id,
          greatest(p.updated_at, coalesce(b.completed_at,b.created_at,p.updated_at), coalesce(f.heartbeat_at,p.updated_at)) AS at
        FROM paper_portfolios p
        LEFT JOIN backtest_runs b ON b.portfolio_id = p.id
        LEFT JOIN forward_accounts f ON f.portfolio_id = p.id
        WHERE greatest(p.updated_at, coalesce(b.completed_at,b.created_at,p.updated_at), coalesce(f.heartbeat_at,p.updated_at)) < now() - interval '1 day'
          AND p.reserved_cash_usd = 0
          AND NOT coalesce((p.state->>'executionUncertain')::boolean, false)
          AND NOT EXISTS (SELECT 1 FROM positions x WHERE x.portfolio_id=p.id AND x.status<>'CLOSED')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.state->'positions') x WHERE x->>'status'<>'CLOSED')
          AND NOT EXISTS (SELECT 1 FROM strategy_evaluation_periods e WHERE e.portfolio_id=p.id AND e.end_at>now())
          AND (b.status IN ('COMPLETED','FAILED','CANCELLED')
               OR (f.status='STOPPED' AND f.heartbeat_at<now()-interval '1 day'
                   AND jsonb_array_length(coalesce(f.checkpoint->'pending','[]'::jsonb))=0))
        UNION ALL
        SELECT 'dataset', d.id::text, d.created_at FROM backtest_datasets d
        WHERE d.status='READY' AND d.created_at<now()-interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM backtest_runs b WHERE b.dataset_id=d.id)
        UNION ALL
        SELECT 'market', e.id::text, e.ingested_at FROM market_events e
        WHERE e.ingested_at<now()-interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.token_mint=e.token_mint AND p.status<>'CLOSED')
        UNION ALL
        SELECT 'gap', g.id::text, g.started_at FROM scanner_gaps g
        WHERE g.ended_at<now()-interval '1 day'
        UNION ALL
        SELECT 'snapshot', s.id::text, s.observed_at FROM market_snapshots s
        WHERE s.observed_at<now()-interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM trading_signals t WHERE t.snapshot_id=s.id)
          AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.token_mint=s.token_mint AND p.status<>'CLOSED')
        UNION ALL
        SELECT 'token', t.mint_address, t.discovered_at FROM tokens t
        WHERE ${unusedToken}
      ) eligible ORDER BY at, kind, id LIMIT 25
    `);
    let candidate: Candidate | undefined;
    for (const row of candidates.rows) {
      if (row.kind === 'portfolio') {
        const lock = await client.query<{ owned: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 8)) AS owned',
          [row.id],
        );
        if (!lock.rows[0]?.owned) continue;
      }
      candidate = row;
      break;
    }
    if (!candidate) {
      await client.query(
        "UPDATE public.solemn_storage_policy SET last_status='NO_ELIGIBLE_DATA', last_cleanup_at=now() WHERE singleton",
      );
      await client.query('COMMIT');
      return 0;
    }
    const immutable = await client.query<{
      table_name: RetentionTable;
      trigger_name: string;
    }>(
      `
      SELECT c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
        AND t.tgenabled='O' AND t.tgname LIKE '%_immutable'
    `,
      [[...tables]],
    );
    for (const trigger of immutable.rows)
      await client.query(
        'ALTER TABLE public."' +
          trigger.table_name +
          '" DISABLE TRIGGER ' +
          client.escapeIdentifier(trigger.trigger_name),
      );

    if (candidate.kind === 'portfolio') {
      const selected = await client.query<{
        strategy_run_id: string;
        run_id: string | null;
      }>(
        'SELECT p.strategy_run_id, b.id AS run_id FROM paper_portfolios p LEFT JOIN backtest_runs b ON b.portfolio_id=p.id WHERE p.id=$1',
        [candidate.id],
      );
      const account = selected.rows[0]!;
      await remove(
        'strategy_evaluations',
        'portfolio_id=$1 OR period_id IN (SELECT id FROM strategy_evaluation_periods WHERE portfolio_id=$1)',
        [candidate.id],
      );
      for (const table of [
        'strategy_evaluation_periods',
        'execution_simulation_attempts',
        'swap_execution_assessments',
        'trades',
        'orders',
        'positions',
        'portfolio_balance_events',
        'operational_audit_events',
        'operational_incidents',
        'forward_runtime_events',
        'forward_accounts',
      ] as const)
        await remove(table, 'portfolio_id=$1', [candidate.id]);
      if (account.run_id) {
        for (const table of [
          'backtest_scenarios',
          'backtest_results',
          'backtest_equity_snapshots',
          'backtest_execution_intents',
        ] as const)
          await remove(table, 'run_id=$1', [account.run_id]);
        await remove('backtest_runs', 'id=$1', [account.run_id]);
      }
      await remove('paper_portfolios', 'id=$1', [candidate.id]);
      const references = await client.query<{ used: boolean }>(
        `
        SELECT EXISTS(SELECT 1 FROM paper_portfolios WHERE strategy_run_id=$1)
          OR EXISTS(SELECT 1 FROM backtest_runs WHERE strategy_run_id=$1)
          OR EXISTS(SELECT 1 FROM orders o JOIN strategy_decisions d ON d.signal_id=o.strategy_candidate_id WHERE d.run_id=$1) AS used
      `,
        [account.strategy_run_id],
      );
      if (!references.rows[0]!.used) {
        for (const table of [
          'strategy_decisions',
          'market_corrections',
          'market_candles',
          'market_coverage_observations',
          'market_trade_observations',
        ] as const)
          await remove(table, 'run_id=$1', [account.strategy_run_id]);
        await remove('strategy_runs', 'id=$1', [account.strategy_run_id]);
      }
    } else if (candidate.kind === 'dataset') {
      await remove('backtest_dataset_events', 'dataset_id=$1', [candidate.id]);
      await remove('backtest_datasets', 'id=$1', [candidate.id]);
    } else if (candidate.kind === 'token') {
      const expired = await client.query<{ mint_address: string }>(
        'SELECT t.mint_address FROM tokens t WHERE ' +
          unusedToken +
          ' ORDER BY t.discovered_at, t.mint_address LIMIT 10000',
      );
      const mints = expired.rows.map((row) => row.mint_address);
      // Clearing the token/assessment FK cycle is part of deletion. The table
      // remains exclusively locked until these cap triggers are restored.
      await client.query(
        'ALTER TABLE public.tokens DISABLE TRIGGER solemn_storage_limit_before',
      );
      await client.query(
        'ALTER TABLE public.tokens DISABLE TRIGGER solemn_storage_limit_after',
      );
      await client.query(
        'UPDATE tokens SET latest_risk_assessment_id=NULL WHERE mint_address=ANY($1::text[])',
        [mints],
      );
      await remove('token_risk_assessments', 'token_mint=ANY($1::text[])', [
        mints,
      ]);
      await remove('tokens', 'mint_address=ANY($1::text[])', [mints]);
      await client.query(
        'ALTER TABLE public.tokens ENABLE TRIGGER solemn_storage_limit_before',
      );
      await client.query(
        'ALTER TABLE public.tokens ENABLE TRIGGER solemn_storage_limit_after',
      );
    } else if (candidate.kind === 'market') {
      await remove(
        'market_events',
        `id IN (
        SELECT e.id FROM market_events e
        WHERE e.ingested_at<now()-interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.token_mint=e.token_mint AND p.status<>'CLOSED')
        ORDER BY e.ingested_at, e.id LIMIT 10000
      )`,
        [],
      );
    } else if (candidate.kind === 'gap') {
      await remove(
        'scanner_gaps',
        `id IN (
        SELECT id FROM scanner_gaps WHERE ended_at<now()-interval '1 day'
        ORDER BY started_at, id LIMIT 10000
      )`,
        [],
      );
    } else {
      await remove(
        'market_snapshots',
        `id IN (
        SELECT s.id FROM market_snapshots s
        WHERE s.observed_at<now()-interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM trading_signals t WHERE t.snapshot_id=s.id)
          AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.token_mint=s.token_mint AND p.status<>'CLOSED')
        ORDER BY s.observed_at, s.id LIMIT 10000
      )`,
        [],
      );
    }
    for (const trigger of immutable.rows)
      await client.query(
        'ALTER TABLE public."' +
          trigger.table_name +
          '" ENABLE TRIGGER ' +
          client.escapeIdentifier(trigger.trigger_name),
      );
    await client.query(
      `
      UPDATE public.solemn_storage_policy
      SET pending_tables=$1, deleted_rows=deleted_rows+$2, last_status='RECLAIMING', last_cleanup_at=now()
      WHERE singleton
    `,
      [[...touched], deleted],
    );
    await client.query('COMMIT');
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** A cross-process lock and durable compaction queue make interrupted cleanup retryable. */
export async function enforceDatabaseStorage(
  pool: Pool,
): Promise<StorageRetentionResult> {
  const client = await pool.connect();
  let deletedRows = 0;
  try {
    const installed = await client.query<{ installed: boolean }>(
      "SELECT to_regclass('public.solemn_storage_policy') IS NOT NULL AS installed",
    );
    if (!installed.rows[0]?.installed)
      return { status: 'NOT_MIGRATED', usedBytes: '0', deletedRows };
    const initial = await policy(client);
    let usedBytes = await usage(client);
    if (
      !initial.cleanup_active &&
      !initial.pending_tables.length &&
      BigInt(usedBytes) < BigInt(initial.limit_bytes)
    )
      return { status: 'BELOW_LIMIT', usedBytes, deletedRows };
    const lock = await client.query<{ owned: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS owned',
      [maintenanceLock],
    );
    if (!lock.rows[0]?.owned) return { status: 'BUSY', usedBytes, deletedRows };
    await client.query("SET lock_timeout='2s'");
    await client.query("SET statement_timeout='120s'");
    await client.query(
      'UPDATE public.solemn_storage_policy SET cleanup_active=true WHERE singleton',
    );
    for (let batch = 0; batch < 4; batch++) {
      const state = await policy(client);
      // A crash or lock timeout after deletion leaves this queue for the next owner.
      for (const table of state.pending_tables) {
        if (!tables.includes(table as RetentionTable))
          throw new Error('Unknown retention table');
        await client.query('VACUUM (FULL, ANALYZE) public."' + table + '"');
        await client.query(
          'UPDATE public.solemn_storage_policy SET pending_tables=array_remove(pending_tables,$1) WHERE singleton',
          [table],
        );
      }
      usedBytes = await usage(client);
      if (BigInt(usedBytes) < BigInt(state.target_bytes)) {
        await client.query(
          "UPDATE public.solemn_storage_policy SET cleanup_active=false, last_status='CLEANED', last_cleanup_at=now() WHERE singleton",
        );
        return { status: 'CLEANED', usedBytes, deletedRows };
      }
      const removed = await pruneBatch(client);
      if (!removed)
        return { status: 'NO_ELIGIBLE_DATA', usedBytes, deletedRows };
      deletedRows += removed;
    }
    return { status: 'MORE_WORK', usedBytes: await usage(client), deletedRows };
  } finally {
    // Closing this connection also releases session advisory locks and local settings.
    client.release(true);
  }
}

export function startDatabaseStorageMonitor(pool: Pool) {
  let running: Promise<void> | undefined;
  let stopped = false;
  const check = () => {
    if (!running && !stopped) {
      running = enforceDatabaseStorage(pool)
        .then((result) => {
          if (
            ['CLEANED', 'MORE_WORK', 'NO_ELIGIBLE_DATA'].includes(result.status)
          )
            console.info(
              JSON.stringify({
                name: 'solemn-worker',
                level: result.status === 'NO_ELIGIBLE_DATA' ? 40 : 30,
                time: Date.now(),
                msg: 'Database storage retention ' + result.status,
                deletedRows: result.deletedRows,
                usedBytes: result.usedBytes,
              }),
            );
        })
        .catch((error: unknown) => {
          const code =
            error !== null && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : 'UNKNOWN';
          console.error(
            JSON.stringify({
              name: 'solemn-worker',
              level: 40,
              time: Date.now(),
              msg: 'Database storage retention will retry',
              code: /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'UNKNOWN',
            }),
          );
        })
        .finally(() => {
          running = undefined;
        });
    }
    return running ?? Promise.resolve();
  };
  const timer = setInterval(() => {
    void check();
  }, 60_000);
  timer.unref();
  void check();
  return {
    check,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
