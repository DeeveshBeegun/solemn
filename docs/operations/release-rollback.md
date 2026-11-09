# Release rollback and recovery

1. Identify the exact running version, database, forward account, active incidents, and deployment configuration. Use `solemn:health`, `solemn:incidents` and `solemn:reconcile` where the database is reachable. Preserve their output securely.
2. Pause the forward account when available. If it is already halted, preserve that state. Stop the worker with SIGTERM and wait for the owner session to exit. Keep the PostgreSQL volume intact.
3. Capture a fresh logical dump before attempting rollback. Store the dump off the deployment checkout with restricted permissions.

```bash
umask 077
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > solemn-pre-rollback.dump
pg_restore --list solemn-pre-rollback.dump
```

4. Restore into a **separate disposable or recovery database** using a compatible PostgreSQL 16 client. Create the target database and required roles separately. Never point a restore or clean operation at the active database. Run the release's read-only reconciliation against the restored account and verify the migration journal, ledger frontier, holdings, fills, fees and open incidents.
5. Select previously reviewed application code and its exact lockfile and runtime. Restore the matching nonsecret settings from your deployment record. Retain current secrets unless incident response requires rotation. Validate old code against a copy of the current schema and retained portfolio history before giving it any write access.
6. If the schema is incompatible, keep the current database as evidence. Restore the matching pre-upgrade backup in a new database and reconcile any activity since that backup before considering cutover. The migration journal is forward-oriented. There is no verified down migration or automatic merge of two ledgers.
7. Resume recovery with the account held in `PAUSED`, or retain `HALTED` where an incident requires it. Check the actual persisted state before starting the worker. Restore only verified read-only connectivity and validate the owner and freshness prerequisites. Use explicit reset for a halt, and an ordinary resume only for a pause. A stopped replay without an active healthy owner cannot be resumed.

Week 12 tested a fresh PostgreSQL 16 migration, `pg_dump -Fc`, restore with `--exit-on-error --single-transaction` into a different database, and byte-identical reconciliation reports for the synthetic portfolio. The restored database retained all 15 migrations, 255 ledger events and four fills. This drill exercised data recovery. Compatibility with an arbitrary older binary remains a separate release-specific test.
