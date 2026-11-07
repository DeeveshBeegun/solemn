# Solemn — Automated Solana Meme Coin Trading System

Solemn is an automated Solana meme coin trading system designed to discover emerging tokens, analyze market activity, identify opportunities, manage risk, and eventually execute trades automatically.

**Current status: Week 1 — Foundation and Infrastructure. PAPER ONLY.** The worker connects only to local PostgreSQL, initializes an empty simulation service with a $100 USD balance, and waits for shutdown. It does not scan Solana, generate signals, sign transactions, or trade. No wallet is required.

## Vision and scope

The longer-term roadmap includes token launch and migration monitoring, market and security analysis, momentum strategies, risk controls, backtesting, forward paper trading, execution-cost tracking, and a monitoring dashboard with emergency controls. None of those operational features are active in Week 1.

This repository provides a strict TypeScript monorepo, runtime validation, a PostgreSQL schema and migration, structured logging, an execution interface, deterministic simulation fixtures, tests, and CI.

## Architecture

```text
apps/worker             @solemn/worker
  config/               Zod environment validation; rejects live mode
  execution/            ExecutionAdapter and in-memory PaperExecutionAdapter
  services/             Logging, lifecycle, graceful database shutdown
  scanner/ strategy/ risk/
                        Reserved directories; intentionally unimplemented
packages/shared         @solemn/shared
  types/ schemas/       Domain types inferred from Zod schemas
  financial.ts          Exact fixed-point BigInt arithmetic
  order-state.ts        Explicit permitted lifecycle transitions
packages/database       @solemn/database
  src/schema.ts         Seven tables, enums, indexes and constraints
  src/repository.ts     Validated, typed token/event/order/trade insertion
  drizzle/              Committed generated SQL and schema metadata
```

The dependency direction is worker → database → shared; worker also uses shared directly. Packages publish ESM build outputs inside the workspace. Root commands build dependencies before consuming them. There are no microservices or external trading dependencies.

### Domain and persistence decisions

- The seven entities are Token, MarketEvent, MarketSnapshot, TradingSignal, Order, Position, and Trade. Zod validates external inputs; TypeScript types derive from those schemas. Optional database fields use explicit `null`.
- Financial amounts and token quantities are decimal **strings**, with at most 60 integer digits and 18 fractional digits. Monetary JavaScript numbers, negatives for unsigned amounts, scientific notation, nonfinite values, and excess precision are rejected. P&L may be signed.
- Calculations use BigInt at a fixed scale of 18. Multiplication that would require rounding is rejected. No balance, fill, quantity, or P&L arithmetic uses floating point. The 18-place simulation limit is separate from a token's on-chain decimals metadata, which may be 0–255.
- PostgreSQL uses exact `NUMERIC` values, returned as strings. CHECK constraints enforce magnitude, scale, finiteness, and sign. Unconstrained `NUMERIC` plus explicit checks is deliberate: `NUMERIC(78,18)` would silently round excessive fractional precision before a check could reject it. Do not register a `NUMERIC` parser that converts values to `Number`.
- Shared model timestamps are UTC ISO 8601 strings. Persistence uses `TIMESTAMPTZ`, with UTC pool sessions. Drizzle string-mode timestamp reads use PostgreSQL timestamp formatting; convert to ISO when mapping rows into validated domain objects.
- Market event deduplication uses the unique pair `(source, source_event_id)`, independently of the event's UUID. A collector must create a stable identity such as `signature:instructionIndex:innerInstructionIndex:logIndex`. A transaction signature alone is insufficient. Events without a transaction signature still require a stable source identity. Duplicate insertion returns `null` and preserves the original raw JSON payload. Distinct events within one transaction remain distinct.
- Blockchain slots are JSON-safe integer strings in the domain and PostgreSQL BIGINT values in the database. Drizzle rows expose slots as `bigint`; convert them to strings before JSON serialization. Raw JSON payloads must represent exact chain quantities as strings too.
- Composite foreign keys enforce signal/snapshot token agreement and trade/order token and side agreement. Orders additionally have a database PAPER-only check. The LIVE enum value describes future architecture and cannot currently be persisted in an order.

### Paper execution semantics

`ExecutionAdapter` supports placing, querying, and cancelling orders. The paper implementation accepts only PAPER requests with a supplied UUID and an exact matching fixture. Every fixture supplies its timestamps and outcome; fills also supply a trade UUID, quantity, price, and fee. There is no price discovery, fabricated market liquidity, wallet access, or network transaction path.

Simulation supports submitted orders, full fills, one partial fill, fixture failures, and cancellation of an unfilled remainder. It tracks exact USD cash and acquired token quantities, refuses overspending and naked selling, and replays an order ID without applying a second fill. Returned objects and input fixtures are copied. Cancelling after a partial fill retains the fill, fees, and holdings. Terminal orders cannot resume.

The adapter is an **in-memory test simulator**, not a durable account ledger. It has no order reservation engine, subsequent partial-fill feed, position accounting, automatic pricing, or restart recovery. The startup instance has no fixtures and cannot execute an unsolicited order. Database persistence is a separate boundary; the worker does not write simulated trades automatically.

## Technology and prerequisites

- Node.js **22.23.4** (pinned in `.nvmrc`; project accepts Node 22.13+ within major 22).
- pnpm **10.34.9** (pinned in `packageManager`).
- Docker Desktop or Docker Engine with Compose v2 supporting `--wait`.
- PostgreSQL **16**, supplied by Compose; no host PostgreSQL installation is needed.
- TypeScript 5.9, Drizzle ORM/Kit, Zod 4, Pino 10, Vitest 5, ESLint 10, Prettier 3.

Dependency versions are pinned and `pnpm-lock.yaml` is included. The Node and pnpm engine checks intentionally reject unsupported host versions. See the [Node release schedule](https://github.com/nodejs/Release#release-schedule) and [Drizzle migration workflow](https://orm.drizzle.team/docs/migrations) for upstream lifecycle and tooling details.

## Installation and first run

Run all commands from this repository's root. With nvm installed:

```bash
nvm install
nvm use
npm install --global pnpm@10.34.9
pnpm install --frozen-lockfile
cp .env.example .env
docker compose --profile test up -d --wait
pnpm db:migrate
pnpm dev
```

`pnpm dev` builds the workspace and runs the worker with `tsx watch`. Press Ctrl+C to stop. Worker-source edits restart it; rebuild with `pnpm build` after changing a dependency package. For the compiled entry point:

```bash
pnpm build
pnpm start
```

Startup emits structured JSON logs for configuration validation, PostgreSQL connectivity, PAPER initialization with `initialBalanceUsd: "100"`, and readiness. It deliberately produces no signals or fills. SIGINT/SIGTERM closes the database pool, clears the keepalive timer, logs shutdown, and exits. Shutdown requests are idempotent, including requests during startup. A 10-second shutdown deadline prevents indefinite hangs. Fatal startup and unexpected errors exit unsuccessfully without dumping connection strings.

## Environment configuration

Copy `.env.example` to `.env`; never commit `.env`. Existing process environment values override the file.

| Variable                                                             | Purpose                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`                                                           | `development`, `test`, or `production`                             |
| `LOG_LEVEL`                                                          | Pino level; defaults to `info`                                     |
| `DATABASE_URL`                                                       | PostgreSQL connection string; required                             |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local Compose development database settings                        |
| `TEST_POSTGRES_PASSWORD`                                             | Password for the separate local test container                     |
| `TEST_DATABASE_URL`                                                  | Dedicated integration database; never falls back to `DATABASE_URL` |
| `SOLANA_RPC_URL`, `SOLANA_WS_URL`                                    | Validated future endpoint settings; never contacted                |
| `TRADING_MODE`                                                       | Must be exactly `PAPER`                                            |
| `ENABLE_LIVE_TRADING`                                                | Must be exactly the string `false`                                 |
| `INITIAL_PAPER_BALANCE_USD`                                          | Positive decimal string; defaults to `100`                         |

Example passwords are local-only development fixtures. When changing Compose credentials, update the corresponding URL and URL-encode special characters in passwords. Changing environment variables does not change credentials in an already-initialized PostgreSQL volume.

## PostgreSQL and migrations

The development database is named `solemn`, persists in `solemn_postgres`, and binds only to loopback on port 5432. The separate test service uses database/user `solemn_test`, port 5433, and temporary in-memory container storage. Both have readiness health checks.

```bash
docker compose up -d --wait postgres
docker compose --profile test up -d --wait postgres-test
docker compose --profile test ps
pnpm db:migrate
```

The initial migration is included. `db:migrate` applies outstanding migrations using Drizzle's migration journal and is safe to repeat. The application does not migrate automatically. To change the schema:

```bash
# Edit packages/database/src/schema.ts first.
pnpm db:generate
# Review the new SQL migration and metadata, then:
pnpm db:migrate
```

Commit SQL and `drizzle/meta` together. Do not edit already-applied migrations or use schema push against persisted data. Migration generation needs no running database; migration application does. Back up valuable data before schema changes. Use a separate deployment migration step and scoped database roles before deploying beyond local development.

To stop local containers while retaining the development volume:

```bash
docker compose --profile test stop
```

Do not add `-v` to a Compose removal command unless you intend to delete local data.

## Tests and quality checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

Unit tests require no running services. They cover configuration and trading-mode restrictions, token and signal schemas, order transitions, exact arithmetic and invalid inputs, fixture simulation, safe test targets, and service shutdown. Integration tests require the dedicated test container; they apply and replay migrations, then roll back every test's fixture transaction. They verify connectivity, UTC, all seven tables, idempotency, precision, referential integrity, lifecycle constraints, and database-level rejection of LIVE orders. No truncation or database drop is used.

Integration tests reject a missing URL, non-loopback host, any database or username other than `solemn_test`, URL query/fragment overrides, or a target matching the configured development database and port. They fail rather than skip when PostgreSQL is unavailable. Do not put real data in the test database.

`pnpm format` applies Prettier. `pnpm lint` checks both ESLint and formatting. GitHub Actions installs with a frozen lockfile, type-checks, lints, runs unit and PostgreSQL 16 integration tests, and builds. CI credentials belong to its temporary service container only.

### Week 1 local verification — 2026-11-07

Verification used Node 22.23.4 and pnpm 10.34.9 in an isolated temporary toolchain; the host's global Node 23/pnpm 11 installation was not changed. Both PostgreSQL 16 Compose containers reached healthy status. This workstation already used port 5432, so its ignored `.env` uses development port **55432**; the example retains the conventional default 5432. The test container uses 5433.

| Executed command/check                              | Result                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` and `pnpm install --frozen-lockfile` | Passed                                                                                                                    |
| `docker compose --profile test up -d --wait`        | Both services healthy                                                                                                     |
| `pnpm typecheck`                                    | Passed, including tests and tooling configuration                                                                         |
| `pnpm lint`                                         | ESLint and Prettier passed                                                                                                |
| `pnpm test`                                         | 69 unit tests passed                                                                                                      |
| `pnpm test:integration`                             | 19 PostgreSQL integration tests passed                                                                                    |
| `pnpm build`                                        | Passed                                                                                                                    |
| `pnpm db:generate`                                  | Generated the initial migration; subsequent generation found no drift                                                     |
| `pnpm db:migrate`                                   | Applied successfully; replay passed                                                                                       |
| `pnpm dev`                                          | Reached PAPER readiness with $100; Ctrl+C closed cleanly                                                                  |
| Compiled entry point smoke checks                   | SIGINT/SIGTERM exited 0; LIVE mode, live flag, and unavailable database exited 1; secret error value was absent from logs |
| `pnpm audit`                                        | Zero reported vulnerabilities with the documented tooling overrides                                                       |

The GitHub Actions workflow is configured; it has not been executed on GitHub from this workspace.

## Troubleshooting

- **Unsupported engine:** run `nvm use` and confirm `node --version` and `pnpm --version` match the pinned versions. Node 23 and pnpm 11 are intentionally outside this project's toolchain.
- **Cannot connect to Docker daemon:** start Docker Desktop/Engine, then retry Compose.
- **Port 5432 occupied:** set `POSTGRES_PORT` and the port in `DATABASE_URL` to the same free value, then recreate only Solemn's development service. A host PostgreSQL installation may already use 5432.
- **Port 5433 occupied:** stop the conflicting service or change the test port mapping and `TEST_DATABASE_URL` together.
- **PostgreSQL connection refused:** check `docker compose --profile test ps`, then `docker compose logs postgres` or `docker compose logs postgres-test` locally. Confirm `.env` URL ports and credentials agree with Compose.
- **Authentication failed after a password edit:** the persistent development volume retains its original credentials. Update the role password using the old credentials or deliberately recreate a disposable database; do not delete valuable data.
- **Missing table:** run `pnpm db:migrate` before using persistence operations. Integration migrations run automatically against the guarded test database.
- **Invalid configuration:** startup names the offending field. PAPER and the lowercase string `false` are mandatory; numeric inputs must be decimal strings without scientific notation.
- **Missing workspace outputs:** use root commands, which build first. `pnpm start` specifically requires a prior `pnpm build`.
- **Fixture requires more than 18 decimals:** reduce fixture precision or defer the operation until an explicit rounding policy is designed. Do not convert to floating point.

## Security considerations

There is no Solana client library, signing implementation, private key setting, or live execution adapter. Config, runtime request validation, and a PostgreSQL CHECK constraint independently reject LIVE execution. The worker never uses the configured Solana endpoints.

Credentials come from environment variables. Configuration errors report fields without received values; operational errors report sanitized error categories/codes without raw SQL, connection strings, or driver messages. Pino also redacts common credential fields. Do not log complete environment objects, raw connection URLs, or raw provider errors in future code.

Compose databases are loopback-only local services. Their bootstrap roles and example passwords are for local development, not public hosting. Production hardening, least-privilege roles, TLS, backups, encrypted secrets, dependency updates, and deployment policy remain future deployment work.

The workspace temporarily overrides tooling dependencies to `minimatch` 11.0.1 and the legacy Drizzle loader's `esbuild` to 0.25.12 to address the [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) and [esbuild advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99). These are development-only dependencies. Lint and migration generation are verified with the overrides. Remove the overrides when upstream tools adopt patched dependency ranges; recheck with `pnpm audit` when updating the lockfile.

## Current limitations and Week 2

This is a paper-only infrastructure milestone. No token scanner, RPC/WS ingestion, real market data, strategy, security scoring, AI, trading automation, or frontend exists. Orders and positions are schema foundations rather than a complete durable execution ledger. Application transitions are enforced in the shared helper; the database enforces valid row shapes, not the entire history of every state transition or aggregate fill totals. Database rows need explicit mapping when used as domain objects.

The next milestone can add a read-only scanner behind an interface, source event identity rules, normalized token/event persistence through the validated repository, recorded ingestion fixtures, replay tests, and data freshness handling. Keep execution in PAPER mode. Before expanding simulation, design durable cash/position accounting, transactionally consistent fills, and explicit rounding/fee policies. No Week 2 collector is implemented prematurely.
