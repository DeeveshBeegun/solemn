# Solemn v0.1.0-rc.1 deployment

The local deployment uses the existing Compose PostgreSQL service and runs the compiled Node worker on the same host. Use Node from `.nvmrc`, pnpm 10.34.9 and PostgreSQL 16. The database port binds to loopback and its named volume persists across process or container restarts. The CLI is local. Restrict access to the checkout, environment file and database credentials.

1. Copy `config/release.env.example` to a new ignored `.env`, or merge its safe settings into the existing file without replacing credentials or a portfolio selection. Choose a strong local database password and ensure the connection URL uses the matching URL-encoded value. Limit permissions on the file.
2. Review `TRADING_MODE=PAPER`, `ENABLE_LIVE_TRADING=false` and `ENABLE_METERED_MARKET_DATA=false`. Optional network clients, fixture paper automation and forward replay start disabled.
3. Start PostgreSQL with `docker compose up -d postgres`. Check `docker compose ps` for a healthy service.
4. Run `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm db:migrate`. For an existing volume, back it up first.
5. Run `pnpm start` from the release checkout. Verify configuration, database connection and PAPER initialization in the Pino logs. Stop with SIGTERM or Ctrl+C and wait for the stopped message.

For persistent operation, supervise the Node process under an unprivileged service user with the checkout as its working directory, the pinned Node executable, restart-on-failure and enough stop time for the documented drain windows. Use the host's log retention controls for structured stdout and restrict log access. PostgreSQL uses Compose's restart policy. Apply bounded container-log retention through host Docker policy. Investigate repeated restarts instead of bypassing the reconciliation gate.

## Offline smoke

Use the disposable Compose test profile and its dedicated `solemn_test` credentials, separate from the application database.

```bash
docker compose --profile test up -d postgres-test
pnpm release:verify
```

The verification command saves command logs, exit codes and a JSON summary in an ignored `reports/release/verify-*/` directory. `pnpm release:smoke` runs the compiled worker and control CLI on the guarded test database only. It checks migration, PAPER startup and SIGTERM shutdown, rejects unsafe configuration, runs a deterministic forward replay, verifies reconciliation and tests halt across process restart. It uses the guarded connection to create a uniquely named scratch database and removes only that database at completion. The disposable test role therefore needs permission to create databases. The smoke leaves the reusable integration database unchanged.

The scanner, risk and provider integration tests use offline fixtures. Optional live discovery may be enabled only within the release restrictions and with metered streams disabled. The Swap V2 quote command remains a separately opted-in research tool. A quote or dry run does not establish executable trade readiness. No public service or administrative API needs to be exposed.
