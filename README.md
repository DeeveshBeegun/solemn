# Solemn — Automated Solana Meme Coin Trading System

Solemn is an automated Solana meme coin trading system designed to discover emerging tokens, analyze market activity, identify opportunities, manage risk, and eventually execute trades automatically.

**Current status: Week 6 — Historical Backtesting. PAPER ONLY.** Chronological replay reuses the momentum strategy and durable paper ledger, adds explicit execution latency, isolated backtest accounts, performance metrics and reports. Bundled datasets are synthetic; the operational real dataset is insufficient for a genuine historical strategy backtest. Live signals and forward paper trading remain **NOT_READY**. No wallets, signing, swaps or real-money orders exist.

## Vision and scope

The longer-term roadmap includes token launch and migration monitoring, market and security analysis, momentum strategies, risk controls, backtesting, forward paper trading, execution-cost tracking, and a monitoring dashboard with emergency controls. Read-only discovery, enrichment, risk screening, momentum replay and durable automated paper trading are implemented. Live market-data integration, real-money execution and the dashboard remain future milestones.

This repository provides a strict TypeScript monorepo, runtime validation, PostgreSQL schemas and migrations, structured logging, an execution interface, deterministic simulation fixtures, tests, and CI.

## Architecture

```text
apps/worker             @solemn/worker
  config/               Zod environment validation; rejects live mode
  execution/            Observation-driven PaperExecutor and legacy fixture adapter
  services/             Logging, lifecycle, graceful database shutdown
  scanner/              One WebSocket, normalization, bounded queue, persistence, gaps
  analysis/             Risk readers, replay market provider, candles and indicators
  risk/                 Security/account risk gates and fee-aware position sizing
  strategy/             Breakout state machine, risk-gated signals, replay and worker service
  portfolio/            Durable paper accounting, monitoring, staged exits and recovery
  backtesting/          Availability-ordered replay, latency, analytics, audit and reports
packages/shared         @solemn/shared
  types/ schemas/       Domain types inferred from Zod schemas
  financial.ts          Exact fixed-point BigInt arithmetic
  order-state.ts        Explicit permitted lifecycle transitions
packages/database       @solemn/database
  src/schema.ts         Twenty-three tables, enums, indexes and constraints
  src/repository.ts     Validated, typed token/event/order/trade insertion
  scannerRepository.ts  Transactional scanner writes and persistent data gaps
  riskRepository.ts     Durable coalesced worklist, assessment history, fresh candidates
  strategyRepository.ts Immutable runs, observations, candles, evidence and candidate queries
  paperRepository.ts    Locked financial transactions, ledger and recovery snapshots
  historyRepository.ts  Immutable datasets and paginated historical observations
  backtestRepository.ts Isolated runs, scheduled executions, equity and results
  drizzle/              Committed generated SQL and schema metadata
```

The dependency direction is worker → database → shared; worker also uses shared directly. Packages publish ESM build outputs inside the workspace. Root commands build dependencies before consuming them. There are no microservices or external trading dependencies.

### Domain and persistence decisions

- The seven foundation entities are Token, MarketEvent, MarketSnapshot, TradingSignal, Order, Position, and Trade. Week 4 adds separately typed market observations, candles, research decisions and candidates. Zod validates external inputs; TypeScript types derive from those schemas. Optional database fields use explicit `null`.
- Financial amounts and token quantities are decimal **strings**, with at most 60 integer digits and 18 fractional digits. Monetary JavaScript numbers, negatives for unsigned amounts, scientific notation, nonfinite values, and excess precision are rejected. P&L may be signed.
- Calculations use BigInt at a fixed scale of 18. Multiplication that would require rounding is rejected. No balance, fill, quantity, or P&L arithmetic uses floating point. The 18-place simulation limit is separate from a token's on-chain decimals metadata, which may be 0–255.
- PostgreSQL uses exact `NUMERIC` values, returned as strings. CHECK constraints enforce magnitude, scale, finiteness, and sign. Unconstrained `NUMERIC` plus explicit checks is deliberate: `NUMERIC(78,18)` would silently round excessive fractional precision before a check could reject it. Do not register a `NUMERIC` parser that converts values to `Number`.
- Shared model timestamps are UTC ISO 8601 strings. Persistence uses `TIMESTAMPTZ`, with UTC pool sessions. Drizzle string-mode timestamp reads use PostgreSQL timestamp formatting; convert to ISO when mapping rows into validated domain objects.
- Market event deduplication uses the unique pair `(source, source_event_id)`, independently of the event's UUID. A collector must create a stable identity such as `signature:instructionIndex:innerInstructionIndex:logIndex`. A transaction signature alone is insufficient. Events without a transaction signature still require a stable source identity. Duplicate insertion returns `null` and preserves the original raw JSON payload. Distinct events within one transaction remain distinct.
- Blockchain slots are JSON-safe integer strings in the domain and PostgreSQL BIGINT values in the database. Drizzle rows expose slots as `bigint`; convert them to strings before JSON serialization. The scanner also stores original message text and lets PostgreSQL parse the original JSON numeric literals without a JavaScript float conversion.
- Composite foreign keys enforce signal/snapshot token agreement and trade/order token and side agreement. Orders additionally have a database PAPER-only check. The LIVE enum value describes future architecture and cannot currently be persisted in an order.

### Paper execution semantics

`ExecutionAdapter` supports placing, querying, and cancelling orders. The paper implementation accepts only PAPER requests with a supplied UUID and an exact matching fixture. Every fixture supplies its timestamps and outcome; fills also supply a trade UUID, quantity, price, and fee. There is no price discovery, fabricated market liquidity, wallet access, or network transaction path.

Simulation supports submitted orders, full fills, one partial fill, fixture failures, and cancellation of an unfilled remainder. It tracks exact USD cash and acquired token quantities, refuses overspending and naked selling, and replays an order ID without applying a second fill. Returned objects and input fixtures are copied. Cancelling after a partial fill retains the fill, fees, and holdings. Terminal orders cannot resume.

The adapter is an **in-memory test simulator**, not a durable account ledger. It has no order reservation engine, subsequent partial-fill feed, position accounting, automatic pricing, or restart recovery. The legacy startup adapter has no fixtures and cannot execute an unsolicited order. Week 5 adds a separate durable paper orchestration path using the existing order/fill contracts, enabled only with an explicit replay configuration.

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

Startup emits structured JSON logs for configuration validation, PostgreSQL connectivity, PAPER initialization with `initialBalanceUsd: "100"`, and readiness. It deliberately produces no signals or fills. SIGINT/SIGTERM stops scanner acceptance and reconnection, closes the socket, drains accepted work, closes the database pool, and clears timers. Shutdown is idempotent, including during startup. The default drain budget is 20 seconds, with a separate 15-second risk-shutdown budget and a further 15-second process deadline allowance for cleanup. The final deadline combines these budgets. Fatal startup and unexpected errors exit unsuccessfully without dumping connection strings.

## Environment configuration

Copy `.env.example` to `.env`; never commit `.env`. Existing process environment values override the file.

| Variable                                                             | Purpose                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                                                           | `development`, `test`, or `production`                                 |
| `LOG_LEVEL`                                                          | Pino level; defaults to `info`                                         |
| `DATABASE_URL`                                                       | PostgreSQL connection string; required                                 |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local Compose development database settings                            |
| `TEST_POSTGRES_PASSWORD`                                             | Password for the separate local test container                         |
| `TEST_DATABASE_URL`                                                  | Dedicated integration database; never falls back to `DATABASE_URL`     |
| `SOLANA_RPC_URL`, `SOLANA_WS_URL`                                    | Used by optional read-only risk analysis (RPC); WebSocket URL reserved |
| `TRADING_MODE`                                                       | Must be exactly `PAPER`                                                |
| `ENABLE_LIVE_TRADING`                                                | Must be exactly the string `false`                                     |
| `INITIAL_PAPER_BALANCE_USD`                                          | Positive decimal string; defaults to `100`                             |

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

Unit tests require no running services. They cover configuration and trading-mode restrictions, token and signal schemas, order transitions, exact arithmetic and invalid inputs, fixture simulation, safe test targets, and service shutdown. Integration tests require the dedicated test container; they apply and replay migrations, then roll back every test's fixture transaction. Scanner end-to-end tests use a loopback mock WebSocket server and the same guarded database. They verify connectivity, UTC, all seven tables, idempotency, precision, referential integrity, lifecycle constraints, and database-level rejection of LIVE orders. No truncation or database drop is used.

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

Only read-only address/mint/extension decoders from the official Solana Kit and token packages are used. There is no signing implementation, private-key setting, or live execution adapter. Config, runtime request validation, and a PostgreSQL CHECK constraint independently reject LIVE execution. The Solana RPC endpoint is contacted only when risk analysis is enabled; SOLANA_WS_URL is not used.

Credentials come from environment variables. Configuration errors report fields without received values; operational errors report sanitized error categories/codes without raw SQL, connection strings, or driver messages. Pino also redacts common credential fields. Do not log complete environment objects, raw connection URLs, or raw provider errors in future code.

Compose databases are loopback-only local services. Their bootstrap roles and example passwords are for local development, not public hosting. Production hardening, least-privilege roles, TLS, backups, encrypted secrets, dependency updates, and deployment policy remain future deployment work.

The workspace temporarily overrides tooling dependencies to `minimatch` 11.0.1 and the legacy Drizzle loader's `esbuild` to 0.25.12 to address the [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) and [esbuild advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99). These are development-only dependencies. Lint and migration generation are verified with the overrides. Remove the overrides when upstream tools adopt patched dependency ranges; recheck with `pnpm audit` when updating the lockfile.

## Week 2 — Real-Time Token Discovery

### Provider contract and cost

The [official PumpPortal real-time documentation](https://pumpportal.fun/data-api/real-time/) lists `subscribeNewToken` and `subscribeMigration` as free. It describes API keys and a funded linked wallet for metered trade subscriptions, which Solemn never requests. A bounded unauthenticated probe on 2026-11-07 connected to `wss://pumpportal.fun/api/data`, acknowledged both free methods, and delivered a creation event. The optional API key is sent only as the `api-key` query parameter; it and credential-bearing URLs are never logged. Provider access rules can change; authentication failures halt retries until configuration is corrected.

Only one scanner process should run against a database at a time. The client uses one shared connection for both subscriptions. There is no configurable arbitrary subscription method and no trade subscription, wallet funding, or order execution path.

### Message flow and supported payloads

```text
PumpPortal → size limit / lossless JSON parsing → conservative Zod validation
           → normalized event + token metadata → bounded FIFO
           → PostgreSQL transaction → structured logs and counters
```

`eventNormalizer.ts` classifies the payload's explicit `txType`, independently of subscription state:

| Provider message                                               | Handling                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `txType: "create"`, valid `mint`                               | `TOKEN_CREATED`                                                                  |
| `txType: "migrate"`, valid `mint`                              | `TOKEN_MIGRATED`                                                                 |
| `message: "Successfully subscribed to token creation events."` | Creation acknowledgement                                                         |
| `message: "Subscribed to 'migration' events."`                 | Migration acknowledgement                                                        |
| Recognized provider error                                      | Sanitized error; authentication failures halt, other errors reconnect            |
| Unknown types or acknowledgement text                          | Explicit rejection counter and warning; never inferred from active subscriptions |
| Invalid JSON, invalid required fields, oversized/binary frames | Rejected with a warning and reconnect/data-gap policy                            |

The documentation does not publish a complete versioned response schema. Both creation and minimal migration payloads were observed live on 2026-11-07 and their sanitized shapes are included as deterministic fixtures. The observed migration contained only signature, mint, `txType`, and venue; optional destination enrichment is additionally tested with a synthetic fixture. Unknown schema changes must be reviewed before extending classification. Acknowledgement text changes may cause a subscription timeout; this favors an explicit failure over falsely claiming coverage.

Known optional fields are `signature`, `slot`, `eventIndex`, `name`, `symbol`, `decimals`, `timestamp`, `creatorPublicKey`/`creator`, `bondingCurveKey`, `poolAddress`, and `pool`. Extra fields are preserved. A numeric `slot` is parsed losslessly and stored as BIGINT. Explicit UTC ISO `timestamp` strings are used as source event times. Numeric timestamps have unknown units and remain unnormalized in the raw message; they are not guessed. Decimals are accepted only when provided and valid. A trader's `traderPublicKey` is preserved but is not assumed to be the creator.

`created_at` is chain/provider creation time when known; `discovered_at` is the earliest accepted local receipt. Event `event_at` is source time when known; `ingested_at` is local receipt time. Missing source timestamps, decimals, names, and symbols remain NULL. The migration observation time is local and distinct from an optional source migration time. Bonding curves and destination pools have separate fields; a venue label is not treated as an address.

### Persistence, ordering and deduplication

`0001_week2_discovery.sql` relaxes unknown metadata/time fields and adds creator, bonding-curve, migration, original-message, and gap-journal fields without deleting Week 1 data. `0002_event_ingestion_index.sql` indexes provider receipt order for inspection and startup coverage checks. Run `pnpm db:migrate` before enabling ingestion.

The scanner repository validates normalized input, takes a transaction-scoped advisory lock for the mint, inserts a token if absent, inserts the event conflict-safely, and enriches token metadata within the same transaction. A duplicate leaves the original receipt time and payload intact. A migration can arrive first and create a token with unknown metadata. A later creation fills missing metadata and cannot regress migration or risk status. The first reliable migration destination supersedes a launch pool; later contradictory destinations remain in event history for future reconciliation.

Event identity is SHA-256 over provider, event type, mint, signature, optional event index, pool address, and migration venue. The primary UUID is a deterministic UUIDv8 derived from that digest. Without an event index, same-type events for the same mint/destination in one transaction may collapse; signature alone is never the key. Without a signature, the fallback is the exact raw-message digest: whitespace, field-order, or payload changes can produce distinct events. There is no exactly-once delivery guarantee.

Original text lives in `market_events.raw_message`, including numeric lexemes and whitespace. PostgreSQL parses that text directly into `raw_payload` JSONB, retaining original JSON value types and exact numbers. The adapter treats numeric lexemes as strings while normalizing. Reading JSONB into JavaScript can still round numeric literals, so use original text or SQL `->>` extraction when replaying exact provider numbers. No ingestion metrics are used for balances, prices, fills, or P&L.

### Start, stop and live smoke test

Existing `.env` files need no replacement. Add settings from `.env.example` as needed; missing scanner settings have validated defaults. Normal tests never use a real provider connection.

```bash
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
pnpm db:migrate

# Explicitly enable read-only blockchain discovery for this invocation.
SCANNER_ENABLED=true pnpm dev
```

To keep connectivity disabled:

```bash
SCANNER_ENABLED=false pnpm dev
```

With risk analysis disabled, neither `SOLANA_RPC_URL` nor `SOLANA_WS_URL` is contacted; only the enabled PumpPortal data connection is opened. `TRADING_MODE=PAPER` and `ENABLE_LIVE_TRADING=false` remain mandatory.

Ctrl+C/SIGTERM stops reconnection and message acceptance first, closes the socket, drains the accepted queue, and then closes PostgreSQL. A shutdown gap remains open until a later successful subscription restoration. If accepted events or gap records exhaust retries or the drain deadline, the worker logs possible loss and exits unsuccessfully. A forced crash or exhausted retry can lose in-memory work; there is no durable message broker.

Run the bounded live smoke separately from an enabled worker, so only one provider connection exists:

```bash
# Default: 20 seconds. Accepted range: 5–60 seconds.
pnpm scanner:smoke
# Optional shorter/longer observation:
SCANNER_SMOKE_SECONDS=30 pnpm scanner:smoke
```

The smoke checks PostgreSQL, subscribes only to enabled free discovery streams, stores received valid events, logs counters, drains, and exits. Success confirms the configured subscription acknowledgements; event counts can be zero during a quiet observation. It never generates an order. It reports failure if acknowledgements are not confirmed. Do not expect a migration in every short sample.

### Configuration and reliability

| Setting                                                         | Default / behavior                                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCANNER_ENABLED`                                               | `false`; explicit opt-in                                                                                                                           |
| `PUMPPORTAL_WS_URL`                                             | `wss://pumpportal.fun/api/data`; only this remote endpoint or loopback mocks are accepted                                                          |
| `PUMPPORTAL_API_KEY`                                            | Empty; optional for the free methods verified above                                                                                                |
| `SCANNER_SUBSCRIBE_NEW_TOKENS`, `SCANNER_SUBSCRIBE_MIGRATIONS`  | Both `true`                                                                                                                                        |
| `SCANNER_RECONNECT_INITIAL_MS`, `SCANNER_RECONNECT_MAX_MS`      | 1000 / 30000; exponential equal jitter between half and all of the capped delay                                                                    |
| `SCANNER_RECONNECT_MAX_ATTEMPTS`                                | `0` means unlimited; a positive limit halts when exhausted                                                                                         |
| `SCANNER_STABLE_CONNECTION_MS`                                  | 30000 before resetting backoff                                                                                                                     |
| `SCANNER_CONNECT_TIMEOUT_MS`                                    | 10000 for connection/subscription acknowledgement                                                                                                  |
| `SCANNER_HEARTBEAT_INTERVAL_MS`, `SCANNER_HEARTBEAT_TIMEOUT_MS` | 30000 / 10000; WebSocket protocol ping/pong, not an invented provider message                                                                      |
| `SCANNER_QUEUE_CAPACITY`                                        | 1000 including the in-flight item; two extra reserved control slots for gap markers                                                                |
| `SCANNER_DB_MAX_ATTEMPTS`, `SCANNER_DB_RETRY_MS`                | 3 attempts / 250 initial milliseconds, exponential capped retry                                                                                    |
| `SCANNER_DRAIN_TIMEOUT_MS`                                      | 20000; after expiry pending items are reported abandoned, retries abort, and the active SQL statement is allowed to settle before closing the pool |
| `SCANNER_METRICS_INTERVAL_MS`                                   | 30000; structured counter snapshots                                                                                                                |
| `SCANNER_MAX_MESSAGE_BYTES`                                     | 65536; bounds transport and parsing memory per frame                                                                                               |

The FIFO has one database writer, so write concurrency is bounded at one and arrival order is preserved within a connection. There is no guarantee of blockchain ordering across reconnects. Transient connection/SQL errors receive bounded retries; integrity and validation errors do not. An ambiguous commit can safely be retried because the token/event transaction is idempotent.

On saturation the current message is explicitly rejected, the connection is terminated, and a data gap opens. Already accepted work drains. Reconnection waits until the queue is empty, then restores both subscriptions with backoff. Malformed relevant frames and terminal persistence failures also open gaps. Rejected unknown messages are counted and warned about without being treated as known events. No rejected body or provider error text is logged. After exhausted persistence retries, an accepted event may be lost; the error, event ID, counters, and conservative gap make that visible.

`scanner_gaps` journals STARTUP, disconnect, timeout, malformed-frame, overload, persistence, and shutdown intervals. A startup interval is conservatively backdated to the last durable receipt/gap observation when available, covering possible crash downtime; the initial start cannot establish coverage before the first observation. Restoring all configured acknowledgements ends open intervals, including prior process downtime. These timestamps describe local coverage, not chain finality. If the gap journal itself cannot be written, structured error logs are the fallback and shutdown is unsuccessful. Run one scanner instance per database; concurrent instances are not coordinated as distributed consumers.

Counters include received messages, valid events, rejected messages, duplicates, successful event writes, failed write attempts (including journal attempts), reconnects, dropped events, current queue depth, connection state, and subscription readiness. Gap writes are not counted as token event writes. Counters reset per process.

### Inspect discovery data

Use `docker compose exec -T postgres psql -U solemn -d solemn` for the example development role/database, then run:

```sql
SELECT mint_address, name, symbol, created_at, discovered_at,
       risk_status, migration_status, migration_observed_at, pool_address
FROM tokens
ORDER BY discovered_at DESC
LIMIT 20;

SELECT event_type, token_mint, transaction_signature, slot,
       event_at, ingested_at, raw_payload
FROM market_events
WHERE source = 'PUMPPORTAL'
ORDER BY ingested_at DESC
LIMIT 20;

SELECT token_mint, transaction_signature, event_at, ingested_at,
       raw_payload->>'pool' AS venue, raw_payload->>'poolAddress' AS destination
FROM market_events
WHERE source = 'PUMPPORTAL' AND event_type = 'TOKEN_MIGRATED'
ORDER BY ingested_at DESC;

SELECT started_at, ended_at, reason
FROM scanner_gaps
ORDER BY started_at DESC;
```

Keep wallet credentials out of these queries. Token names and provider metadata are untrusted input. Discovering a token does not establish that it is safe or profitable. PumpPortal describes its data as [processed commitment](https://pumpportal.fun/FAQ/); events may be provisional. Reconnecting cannot recover missed events or guarantee historical completeness. There is no historical replay API integration, on-chain finality/reorg reconciliation, metadata HTTP fetching, risk analysis, price inference, or trading strategy.

### Test the scanner and plan Week 3

```bash
pnpm test
docker compose --profile test up -d --wait postgres-test
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm build
```

Unit tests use an injectable fake transport and deterministic synthetic fixtures. Integration tests use guarded `solemn_test` transactions that roll back, and a local mock WebSocket server to verify launch, duplicate, migration, interruption, resubscription, exact raw preservation, and graceful draining. No API key or live blockchain connection is required. CI runs these same test projects; it never invokes `scanner:smoke`.

### Week 2 verification — 2026-11-07

The final local suite passed on Node 22.23.4 / pnpm 10.34.9: **102 unit tests and 28 integration tests**, including the loopback mock-server end-to-end test. Frozen installation, type checking, ESLint/Prettier, production build, migration application/replay, and schema drift checks passed. `pnpm audit` reported zero vulnerabilities. Integration transactions left zero token, event, or gap fixtures in `solemn_test`. The hosted GitHub Actions run remains unverified.

The documented **20-second live smoke** succeeded without an API key. Both free subscriptions were acknowledged. It received five messages: two acknowledgements and three valid events. PostgreSQL inspection confirmed **two token creations and one migration**, three distinct event IDs, and all three original messages retained. There were **zero rejected messages, failed writes, or dropped events**; the queue drained to zero and the socket closed normally with code 1000. The migration arrived before any creation observation for that token: it produced a MIGRATED token with unknown name/creation time and a known local migration observation, without inventing a destination address.

Representative actual log fields (host, timestamps, IDs, and mint addresses omitted):

```json
{"subscription":"subscribeNewToken","msg":"PumpPortal subscription established"}
{"subscription":"subscribeMigration","msg":"PumpPortal subscription established"}
{"eventType":"TOKEN_MIGRATED","msg":"Token migration observed and persisted"}
{"eventType":"TOKEN_CREATED","msg":"New token discovered and persisted"}
{"messagesReceived":5,"validEvents":3,"successfulWrites":3,"failedWrites":0,"droppedEvents":0,"queueDepth":0,"subscriptionsReady":true,"msg":"Scanner smoke observation complete"}
```

Startup and shutdown gap markers were verified in the development database. Reconnection, duplicate handling, overload, and failure injection were tested against fake/local transports; no provider interruption was forced during the live smoke. Separate compiled-worker checks confirmed offline startup, SIGINT/SIGTERM exit 0, LIVE/enable-flag rejection, and sanitized database startup failure exit 1. Both local PostgreSQL containers remain healthy; the scanner and smoke process are stopped.

Week 3 enrichment and risk screening are documented below. Durable cash/position accounting, execution rounding/fees, and finality reconciliation remain future work. Temporary development-tool overrides remain documented above.

## Week 3 — Token Security and Risk Analysis

### Data sources and request budgets

The [Jupiter Tokens V2 lookup](https://developers.jup.ag/docs/tokens/token-information) uses only `GET /search?query=<mint[,mint...]>`. It supports up to 100 mints per request. The [current rate-limit page](https://developers.jup.ag/docs/portal/rate-limits) permits keyless access at 0.5 requests/second and a free key at 1 request/second; the generated endpoint reference still labels a key required, so deployments should check the current overview and actual responses. `JUPITER_API_KEY` is optional and supplied only in `x-api-key`. Solemn defaults to one Jupiter request every 2000 ms even when a key is supplied. No paid plan, swap endpoint, or subscription is used.

On-chain checks use only [Solana getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts) with base64 account data and **confirmed** commitment, batched up to 100 addresses. Public RPC requests are spaced at least one second apart. Analysis concurrency defaults to two tokens, typically sharing one request to each provider. These are separate provider budgets; other applications using the same IP/key may still cause rate limiting.

Both readers bound response bodies to 2 MiB, time out each request, serialize requests per provider, and retry transient network/HTTP failures with exponential backoff. HTTP 401/403 are not retried immediately. HTTP 429 honors `Retry-After` and Jupiter reset timestamps. Long cooldowns return an error with `retryAt` rather than holding a job indefinitely; reassessment respects that time. Redirects are rejected, request/error bodies and credential-bearing URLs are not logged, and provider error responses are not stored as raw evidence because they may echo credentials.

Jupiter results are checked against the exact requested mint set. Wrong IDs or duplicate returned IDs are errors, not metadata for another token. Missing tokens produce MISSING/UNKNOWN. Successful observations are cached with their original receipt/update timestamps; caching never makes old data fresh. The cache is bounded and successful cache entries expire after 30 seconds by default. Concurrent requests coalesce by mint. Migration/manual requests invalidate cached metadata. Optional names, symbols, decimals, program, price, market cap, holder count, verification, Organic Score, audit flags and activity windows are retained when available; raw successful responses preserve other fields.

### On-chain security policy

The implementation uses the current official `@solana/kit`, `@solana-program/token`, and `@solana-program/token-2022` decoders. The legacy web3.js/SPL dependency chain was replaced after its audit exposed an unpatched native-buffer advisory. The current installed production dependency audit is recorded in the verification report below.

The analyzer verifies account owner, mint size/layout, initialized state, authority-option encodings, decimals, and exact U64 base-unit supply. Missing accounts and failed RPC calls never become revoked-authority claims. Active mint/freeze authorities are hard rejections when obtained from a valid fresh mint observation. An observed unsupported owner is rejected; malformed or unverifiable extension/security state does not pass.

For Token-2022, the base mint and TLV framing/account prefix are validated. Known accepted/excluded extension payloads are decoded with the official extension decoder. This research policy excludes the **presence** of PermanentDelegate, TransferHook, TransferFeeConfig, NonTransferable, DefaultAccountState, PausableConfig, and PermissionedBurn. Presence is deliberately excluded even when a particular configuration appears inactive; it is a strategy screening policy, not a claim of fraud. No fee, hook, or seizure-capable token is silently treated like a standard SPL mint.

A bare Token-2022 mint and a correctly decoded MetadataPointer are supported. Other known/unknown extensions, including unimplemented metadata/group/confidential/scaled-amount capabilities, result in UNKNOWN unless another verified hard rejection exists. This is conservative coverage, not a complete interpreter of every extension. Truncated, duplicated or malformed TLV data cannot assert that authorities or extensions are safe. Authorities/program state may change after any observation; these checks are not a permanent certificate.

### Liquidity, concentration and classification

Amounts and percentages are normalized from lossless JSON numeric lexemes using string operations. Exact comparisons use BigInt-backed decimal arithmetic. Scientific notation from the provider is expanded exactly; unsupported magnitude/precision becomes an explicit issue/UNKNOWN instead of rounding. Decimals, time intervals and rate-limit timings are ordinary bounded integers, not authoritative balances.

The initial experimental policy requires at least **$40,000 reported aggregate liquidity**, at most **35% Jupiter top-holder concentration**, and data younger than **60 seconds**. A deterioration greater than **50%** relative to a usable fresh previous observation is also rejected. The comparison uses exact cross-products and is disabled when the prior observation is unavailable or stale. These are research thresholds, not validated profit predictors.

Liquidity uses both local fetch time and the provider record's `updatedAt`; future, missing or stale times fail freshness. `updatedAt` is a record-level timestamp, not a documented per-pool liquidity observation, so component-level freshness cannot be independently guaranteed. Jupiter aggregate liquidity is not executable pool depth, locked liquidity, or a price-impact estimate. No pool-reserve simulation or HTTP metadata fetching is implemented.

Jupiter reports `audit.topHoldersPercentage` on a 0–100 scale. The referenced response contract does not fully specify the top-N population, owner aggregation, or pool-vault exclusions. The metric is preserved with its source and treated as a supporting concentration indicator. Holder count is retained when available. No developer identity, coordinated-wallet group, ownership linkage, or wallet-owner concentration is inferred from token-account balances.

Rule precedence is deterministic:

1. Fresh verified hard violations → **REJECTED**, with all applicable machine-readable reasons.
2. Otherwise, mandatory missing, stale, unsupported, failed or conflicting evidence → **UNKNOWN**.
3. Only complete passing mandatory checks → **ELIGIBLE**, with an explicit expiry.

ELIGIBLE means only that the configured screening rules passed. It is not a safety, trust, finality, or profitability guarantee. RPC authority results are authoritative for the current on-chain checks; optional Jupiter authority flags remain nullable, and an available disagreement prevents eligibility. Fresh explicit suspicious-provider flags reject.

**The default policy requires an explicit clear suspicious flag.** Jupiter may omit `isSus` for unflagged tokens; omission stays NULL and therefore UNKNOWN under the default policy. It is never changed to false. `RISK_REQUIRE_EXPLICIT_SUSPICIOUS_FLAG=false` is an explicit experimental policy relaxation; evidence still records NULL. Holder data is similarly mandatory by default. Organic Score and verification status are recorded rather than treated as proof of safety.

### Persistence and reassessment

Apply `0003_token_risk_analysis.sql` and `0004_risk_freshness_index.sql` through `pnpm db:migrate`. The assessment table stores every persisted historical classification, reason codes, checks, full policy/version/hash, source observations, raw successful Jupiter response text, raw mint bytes, errors, source/receipt times, and assessment/expiry times. No numeric risk score is invented. A separate enrichment table is unnecessary because each historical assessment contains its supporting snapshots.

Token rows form a **durable coalescing worklist**: one latest request per persisted token, not one unbounded in-memory job per message. The scanner transaction inserts the event and marks analysis pending together when enabled (or when an already analyzed token receives new information). The token immediately becomes UNKNOWN and loses current eligibility. Duplicate events do not reset work. No external API call occurs inside scanner ingestion.

The coordinator claims at most `RISK_ANALYSIS_CONCURRENCY` rows using row locks/SKIP LOCKED and a bounded lease. It fetches each source in batches, evaluates, then persists assessment and current token state in one transaction. Unique `(request_id, attempt)` prevents duplicate history entries. Request ID, attempt number and assessment time guard current-state updates: a late asynchronous result is retained as historical evidence and cannot overwrite a newer request/attempt. A database write failure leaves the claim UNKNOWN and recoverable after its lease; it is logged rather than presented as eligibility.

Each request has a fixed attempt budget, default **three**. Scheduled reassessments can observe indexing, liquidity or permission changes during that budget. Migrations and explicit manual requests create a new request and renew the budget. After the budget is exhausted, external polling for that request stops. There is no continuous authority subscription or unlimited per-token polling. New information or a manual request is needed beyond that window. Crash recovery can reclaim expired leases within the remaining budget; repeated crashes may exhaust it.

Expired eligibility is invalidated by the coordinator. **Week 4 must use `listEligibleRiskCandidates(db, now, policyHash)`**, which independently enforces current request, current policy, matching assessment, unleased state and future expiry even while the coordinator is stopped. Do not admit tokens using `tokens.risk_status` alone: it is the last stored classification and can age while services are disabled. A failed or pending reassessment is immediately UNKNOWN and cannot expose the previous eligible result.

Shutdown stops scanner acceptance/drains its accepted writes, then aborts external risk calls and awaits the active bounded analysis batch before closing PostgreSQL. Pending token requests survive restart. Errors/deadline overruns are reported; no pool closure is deliberately raced against an active analysis batch.

### Configuration and commands

All external risk networking is opt-in. Existing `.env` files can keep the default off; add variables from `.env.example` as needed. Tests inject transports/readers and require no API key.

```bash
pnpm install --frozen-lockfile
pnpm db:migrate

# Discovery plus automatic read-only screening:
SCANNER_ENABLED=true TOKEN_RISK_ANALYSIS_ENABLED=true pnpm dev

# Completely local operation:
SCANNER_ENABLED=false TOKEN_RISK_ANALYSIS_ENABLED=false pnpm dev

# One bounded manual assessment/reassessment, with a minimal record if absent:
pnpm risk:assess So11111111111111111111111111111111111111112
```

`risk:assess` explicitly enables risk calls for one mint, persists a fresh request, runs one claimed assessment, logs the result, then closes resources. It does not start a background polling timer and has a 120-second hard deadline. UNKNOWN is a valid persisted result, including an unindexed token or a provider failure; inspect the evidence rather than treating CLI completion as proof that all sources succeeded. The request's remaining bounded retry work can be resumed by an enabled worker. Do not run duplicate scanner processes alongside the live scanner smoke command.

| Setting                                                             | Default                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `TOKEN_RISK_ANALYSIS_ENABLED`                                       | `false`                                                        |
| `JUPITER_TOKENS_BASE_URL`, `JUPITER_API_KEY`                        | V2 URL / empty optional key                                    |
| `JUPITER_REQUEST_INTERVAL_MS`, `RISK_RPC_REQUEST_INTERVAL_MS`       | 2000 / 1000                                                    |
| `JUPITER_CACHE_TTL_MS`, `JUPITER_CACHE_MAX_ENTRIES`                 | 30000 / 1000                                                   |
| `RISK_MIN_LIQUIDITY_USD`, `RISK_MAX_TOP_HOLDERS_PERCENTAGE`         | `40000` / `35`, exact decimal strings                          |
| `RISK_MAX_LIQUIDITY_DROP_PERCENTAGE`, `RISK_MAX_DATA_AGE_SECONDS`   | `50` / 60                                                      |
| `RISK_REQUIRE_HOLDER_DATA`, `RISK_REQUIRE_EXPLICIT_SUSPICIOUS_FLAG` | both `true`                                                    |
| `RISK_POLICY_VERSION`                                               | `solemn-week3-v1`; full threshold policy is also hashed/stored |
| `RISK_ANALYSIS_CONCURRENCY`, `RISK_ANALYSIS_RETRY_LIMIT`            | 2 tokens / 3 attempts per request                              |
| `RISK_REASSESS_INTERVAL_MS`, `RISK_POLL_INTERVAL_MS`                | 60000 / 1000; the poll only claims ready database work         |
| `RISK_HTTP_TIMEOUT_MS`, `RISK_HTTP_MAX_ATTEMPTS`                    | 8000 / 3 per HTTP request                                      |
| `RISK_HTTP_RETRY_MS`, `RISK_HTTP_MAX_BACKOFF_MS`                    | 1000 / 60000                                                   |
| `RISK_JOB_LEASE_MS`, `RISK_SHUTDOWN_TIMEOUT_MS`                     | 300000 / 15000                                                 |

Configure the lease longer than the worst expected HTTP/retry/SQL duration. Non-loopback risk URLs require HTTPS when enabled; the Jupiter base cannot contain query credentials. Default keyless/free/public budgets cannot be lowered below their supported intervals for remote providers. Share the provider budget with other applications; local limiting cannot guarantee a shared key/IP has spare quota.

### Inspect risk history and candidates

```sql
SELECT t.mint_address, t.risk_status, t.risk_assessed_at, t.risk_valid_until,
       a.reasons, a.policy_version, a.policy_hash
FROM tokens t
LEFT JOIN token_risk_assessments a ON a.id = t.latest_risk_assessment_id
ORDER BY t.risk_assessed_at DESC NULLS LAST LIMIT 20;

SELECT token_mint, status, reasons, assessed_at,
       evidence->'jupiter'->>'state' AS enrichment_state,
       evidence->'jupiter'->>'updatedAt' AS provider_updated_at,
       evidence->'solana'->>'mintAuthorityDisabled' AS mint_disabled,
       evidence->'solana'->>'freezeAuthorityDisabled' AS freeze_disabled,
       evidence->'solana'->'extensions' AS extensions,
       evidence->'jupiter'->'error' AS jupiter_error,
       evidence->'solana'->'error' AS rpc_error
FROM token_risk_assessments ORDER BY assessed_at DESC LIMIT 20;

SELECT token_mint, reasons, assessed_at
FROM token_risk_assessments WHERE status = 'REJECTED'
ORDER BY assessed_at DESC LIMIT 20;

SELECT mint_address, risk_trigger, risk_attempt_count,
       risk_next_assessment_at, risk_lease_until
FROM tokens WHERE risk_request_id IS NOT NULL
ORDER BY risk_requested_at DESC LIMIT 20;
```

Run `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Most integration fixtures roll back. The concurrent risk end-to-end test needs independent connections: it first refuses existing fixture keys, then cleans up only its owned mints/assessment/event/gap IDs inside the guarded test database. No global truncate or production/development database fallback is used.

The end-to-end test verifies eligible, active-mint-authority rejected, missing-liquidity unknown, duplicate admission, and migration-driven reassessment. Other tests cover older asynchronous results, expired leases, expiry/policy-scoped candidates, exact values, source conflicts, malformed accounts, Token-2022 capabilities, HTTP failures, caching and throttling. Synthetic tests are not evidence of real-world rug-pull detection.

No automatic filter can guarantee protection from scams, rug pulls, liquidity removal, coordinated wallets, or token-price manipulation. Week 4 can consume only fresh eligible candidates for research momentum analysis, with fresh revalidation before any future action. No momentum strategy, trade, wallet, swap, stop-loss, or execution feature is implemented in Week 3.

### Week 3 verification — 2026-11-08

The final local suite passed **148 unit tests and 35 integration tests** on Node 22.23.4 and pnpm 10.34.9. Frozen installation, strict type checking, ESLint/Prettier, unit/integration tests, production build, migration application/replay and schema-drift generation were executed successfully. The latest full dependency audit reported zero vulnerabilities after selecting the current official Kit/token decoders. Optional WebSocket native accelerator build scripts remain disabled; the tested Node implementation works without enabling them. Hosted GitHub Actions has not been run from this workspace.

A bounded manual live check was executed with retries disabled:

```bash
RISK_HTTP_MAX_ATTEMPTS=1 RISK_ANALYSIS_RETRY_LIMIT=1 pnpm risk:assess So11111111111111111111111111111111111111112
```

It made a successful Jupiter lookup and confirmed RPC mint read, persisted one assessment, and exited cleanly. The mint was valid with both mint and freeze authorities disabled. The result was **UNKNOWN**, with reason **SUSPICIOUS_FLAG_UNAVAILABLE**, because the provider omitted its suspicious-token flag. Neither source failed, and no rate limit was observed. This confirms the live request/decoding/persistence path and the strict missing-data policy; it does not validate real-world scam/rug-pull detection or certify this asset.

The mock end-to-end workflow separately verified ELIGIBLE, REJECTED due to active mint authority, UNKNOWN due to missing liquidity, and migration reassessment. Existing Week 2 mock discovery/reconnect tests remained green. Compiled-worker checks exercised offline startup, SIGINT/SIGTERM, LIVE-mode rejection and sanitized database failure. All owned integration fixtures were removed/rolled back from the dedicated test database; the live assessment remains in the development database for inspection.

Both networking switches remain opt-in. Tokens discovered while analysis has never been enabled are not automatically bulk-backfilled; use a bounded manual request or a subsequent discovery/migration event. A policy change requires reassessment for admission under its new hash. Full pool-depth/LP-lock analysis, wallet-owner clustering, continuous permission monitoring, broad extension interpretation and finality reconciliation remain beyond this milestone.

## Week 4 — Momentum Strategy and Signal Engine

Solemn now records deterministic `SOLEMN_LAUNCH_MOMENTUM_V1` BUY candidates in **PAPER** mode. These are experimental research hypotheses, not proven profitable predictions. Nothing submits orders, signs transactions, or opens positions.

### Data availability and operating modes

The existing PumpPortal creation/migration events lack individual trade history. Jupiter enrichment supplies aggregates, not a continuous trade stream. Neither supports reliable minute momentum. Consequently **live signal generation is NOT_READY**. No paid trade adapter is installed; `ENABLE_PAID_TRADE_STREAM=true` is rejected. Existing scanner and risk services continue independently.

`MARKET_DATA_PROVIDER=FIXTURE` is the only implemented adapter. The normalized input includes source event identity, event and receipt timestamps, side, precise amounts, quote mint, pool, USD conversion provenance and buyer address where supplied. Unknown conversion, direction, buyer identity, pool age or coverage remains unavailable. SOL is never interpreted as USD. Distinct buyer addresses need not represent independent traders.

The bundled replay creates five explicitly synthetic markets: valid breakout, weak momentum, rejected risk, failed breakout, and incomplete observations. Synthetic risk observations use the Week 3 evaluator and remain inside replay evidence; they do not create real tokens or overwrite canonical risk history.

### Run and inspect the replay

After starting PostgreSQL and configuring `.env` as above:

```bash
pnpm db:migrate
pnpm strategy:replay
# Or supply normalized SOLEMN_MARKET_REPLAY_V1 JSON:
pnpm strategy:replay /absolute/path/to/replay.json
```

The default replay covers 18 minutes and produces 90 decisions, 90 candles, 1,080 normalized trades and one `FIXTURE` BUY candidate. Its completed breakout candle ends at `2026-01-01T00:14:00.000Z`; evaluation occurs at `00:14:05`, reference price is `124` fixture USD and prior resistance is `120`. This is signal replay, without a profitability calculation.

Repeated identical input/configuration uses identical run, decision and candidate IDs. Inserts suppress duplicates. Configuration or dataset changes create a separate run and preserve prior results. Replay input is capped at 10 MiB, two hours, 20,000 trades per market and the configured tracked-market limit (default 10). A malformed or over-capacity input fails closed.

To enable background strategy processing, set `STRATEGY_ENABLED=true`. With no `STRATEGY_FIXTURE_PATH`, the worker polls the current eligible risk worklist in bounded batches and records `INSUFFICIENT_DATA / LIVE_MARKET_DATA_NOT_READY` once per assessment/configuration. With an explicit fixture path, it performs one finite replay on a separate async processing path. Scanner callbacks never calculate indicators. Shutdown stops strategy work before scanner, risk and database services.

```sql
SELECT r.mode, d.token_mint, d.timestamp, d.outcome,
       d.payload->'reasons' AS reasons,
       d.payload->'candidate' AS candidate
FROM strategy_decisions d
JOIN strategy_runs r ON r.id = d.run_id
ORDER BY d.timestamp DESC;

SELECT signal_id, timestamp,
       payload->'candidate'->>'referencePriceUsd' AS price_usd,
       payload->'candidate'->'features' AS features
FROM strategy_decisions
WHERE mode = 'FIXTURE' AND outcome = 'BUY_CANDIDATE'
ORDER BY timestamp DESC;
```

### Candles, indicators and entry rules

Candles use UTC half-open minute intervals `[start, end)` and finalize five seconds after their end by default. Coverage must explicitly confirm the complete interval by that cutoff; an observed empty interval has zero volume and no price, while unobserved coverage has unavailable volume. Duplicates use source identity. Timely out-of-order events sort by event time; contradictory same-time prices make the candle unusable. Late/conflicting trades are separate correction records and block affected future analysis windows; they never silently rewrite finalized decisions. Restoring coverage after a gap requires a fresh complete history. There is no intrabar strategy.

Amounts use decimal strings and BigInt arithmetic. Ratio evidence stores exact numerator/denominator; threshold comparisons use cross multiplication. Display ratios truncate at 18 fractional digits. Price momentum is expressed as percentage change over 1, 5 and optional 15 minutes. Five-minute acceleration compares total volume with the preceding complete five minutes. Buy/sell pressure and distinct buyers use the same recent five-minute window. Zero denominators have their own unavailable classification. Volatility is `100 * sum(high-low) / sum(close)` across five completed candles, a price-weighted mean range measure; it is not a return predictor.

Entry requires ten continuous, completed, valid candles; positive 1m and 5m momentum; volume acceleration at least 2; buy/sell ratio at least 1.5; at least 40 identifiable buyers; volatility at most 25%; pool age 2–90 minutes from actual pool creation; and fresh liquidity at least USD 40,000. Fifteen-minute momentum is recorded when 16 completed closes exist and is optional.

The state machine observes a close more than 5% above the preceding three candle highs, records that candle's high as resistance, then requires a separate candle with at least a 10% pullback. A later completed close must exceed the previously recorded resistance by more than 1%, with all activity filters passing. The current breakout high never redefines its own resistance. A failed pullback, ten-minute expiry, stale feed, missing prerequisites or risk failure resets/expires the pattern. Accepted opportunities have a deterministic key plus a configurable 300-second cooldown.

Risk must be the current request's latest `ELIGIBLE` assessment, match the current risk-policy hash, be unexpired and younger than 120 seconds. The original Jupiter/Solana evidence is reevaluated at decision time, including the stricter Week 3 source freshness requirements. A newer `REJECTED` or `UNKNOWN` status blocks eligibility. Low strategy activity or out-of-range age yields `NO_SIGNAL`; missing mandatory market evidence yields `INSUFFICIENT_DATA`; failed risk gates yield `BLOCKED_BY_RISK`.

All research thresholds, timing limits and version are validated and documented in `.env.example`. `strategyPolicy()` centralizes the configuration; its hash accompanies every run/candidate. Additional defaults are a 5% initial spike, 25% maximum range volatility and 600-second pattern expiry. Do not tune these values using future replay prices and treat the result as validated performance.

### Persistence, verification and Week 5

Migration `0005_momentum_strategy.sql` adds `strategy_runs`, `market_trade_observations`, `market_coverage_observations`, `market_candles`, `market_corrections` and `strategy_decisions`. Original datasets/configuration and normalized observations are separate from derived candles/features. Decisions embed risk evidence, before/after breakout state, transitions, reasons, timestamps and source references. Indexes support mint/time queries; unique identities and atomic transactions protect retries. Database constraints prohibit BUY candidates in `LIVE_NOT_READY` runs.

The previous `trading_signals` table describes execution-oriented BUY/SELL/HOLD signals. Week 4 candidates have a distinct analysis contract and are stored separately. Week 5 can consume `listFixtureBuyCandidates(db, runId, true)` only through explicit fixture opt-in. Week 4 alone does not execute candidates; Week 5 consumes them only through explicit fixture opt-in. A genuine trade provider with reliable coverage, conversion and receipt-time provenance is still required before live candidate generation can be enabled.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

Tests use local fixtures and a dedicated guarded test database. They cover OHLC/boundaries, missing data, exact arithmetic, risk/currentness/freshness, feed gaps, ordered state transitions, cooldown, no lookahead, deterministic replay, duplicate insertion, versioned history and unchanged order/trade tables. Structured Pino replay logs include decisions, reasons and state transitions; summary counters include evaluations, risk blocks, insufficient data, candidates, duplicate decisions and processing latency.

## Week 5 — Automated Paper Trading

Week 5 connects authentic, persisted Week 4 `BUY_CANDIDATE` records to a durable **PAPER** portfolio. Deterministic replay automatically simulates entry, monitors explicit sell-side observations, attempts exits and journals the resulting accounting. **Forward paper trading is NOT_READY:** Solemn still lacks a sufficiently complete live execution-observation feed. Launch/migration events and occasional Jupiter snapshots cannot substitute for that feed. No wallet, private keys, signing, swap API or blockchain execution is used.

### Run the two fictional scenarios

With Node 22, pnpm and the local PostgreSQL services configured:

```bash
pnpm db:migrate
pnpm paper:replay
pnpm paper:replay --scenario=blocked-stop
# A custom, explicitly labelled SOLEMN_PAPER_REPLAY_V1 JSON file:
pnpm paper:replay /absolute/path/to/paper-replay.json
```

Invoking `paper:replay` is explicit fixture opt-in. The file embeds a Week 4 market dataset plus execution observations with independent timestamps, side, pool, price, USD provenance, liquidity assumptions and optional impact/failure inputs. The bundled scenarios use fictional quotes; they are not prices collected from a real venue. File input is limited to 10 MiB, the existing two-hour strategy dataset bound, the tracked-token limit, and 1,000 execution observations. Portfolio replay history is capped at 1,000 positions; use separate research accounts for larger experiments.

The first scenario starts with $100, consumes the real output of the fixture strategy, and budgets at most $1 including entry fees. It then simulates the first and second profit targets, a new trailing high and a trailing exit. The second scenario crosses the stop threshold after liquidity falls to zero: its sell fails and the position stays `EXIT_BLOCKED`, with its quantity and cost basis intact. These are deterministic accounting demonstrations, not profitability validation or historical backtests.

Logs report the portfolio UUID. Inspect a portfolio and its reconstructed ledger with:

```bash
pnpm paper:inspect PORTFOLIO_UUID
pnpm paper:halt PORTFOLIO_UUID --reason="Operator review"
# Explicit administration only; never performed automatically on startup:
pnpm paper:reset PORTFOLIO_UUID --reason="Reviewed risk state and resumed research"
```

`paper:reset` resets the peak/daily risk baselines and clears the halt only when open positions have fresh marks and no unresolved blocked exits. It does not change cash, positions, fees or realized P&L. The action and reason are journalled. Daily-loss limits otherwise reset at the first processed event of a new UTC day; a total-drawdown halt stays latched until an explicit reset.

### Accounts, sizing and entry controls

Accounts have dedicated UUIDs. By default an ID derives from the replay, account name and full strategy/risk/execution configuration. The definition is immutable. Repeating the same command resumes that account and suppresses duplicate operations; it never deposits another $100. A different scenario/configuration gets a different account. Set `PAPER_PORTFOLIO_ID` to explicitly select an existing matching account; incompatible reuse is rejected.

Initial defaults are 1% maximum all-in allocation and three concurrent positions. Allocation is a fraction of current marked equity, capped by available cash; it is not a promise that only 1% can be lost. Quantity sizing includes the modeled entry fee and rounds down. It rejects an order below the $0.01 minimum notional or simulation quantity precision. One active position per mint/account is enforced in both application rules and a database unique index. An unpriced/stale position blocks new entries rather than providing invented equity for sizing.

An entry also requires the configured strategy/version/hash, a recent signal, its current fresh Week 3 assessment, matching risk policy, explicit reliable market observations for the same mint/pool, available cash and account limits. Week 3 security evidence is reevaluated at entry time. A newer risk request, UNKNOWN/REJECTED status, stale source evidence or mismatched assessment blocks the entry. Portfolio/signal IDs form the stable entry command and order identities. Risk/market failures are recorded as rejected decisions; execution-model failures have a persisted `FAILED` order with its reason.

`PAPER_TRADING_ENABLED=false` by default. Worker replay additionally requires `PAPER_ALLOW_FIXTURE_SIGNALS=true` and `PAPER_REPLAY_PATH`; it uses the same pipeline as the CLI. Without them, enabling paper trading reports `NOT_READY`. The scanner remains an independent async service. A configured existing account is recovered before processing, and shutdown stops paper work before strategy/scanner/risk/database services. A processing error stops new work and attempts a durable `HALTED` event; a database outage can prevent recording that event, in which case processing remains stopped. Accepted paper operations are synchronous within a database transaction, with no pending external order to drain or ambiguously resume.

### Execution model and order lifecycle

The Week 1 `ExecutionAdapter`, `OrderRequest`, `OrderResult` and order state machine remain available for existing tests. The new stateless `PaperExecutor` reuses those order/fill contracts; a portfolio transaction supplies persisted cash/holdings and owns idempotency. The legacy in-memory adapter is not the durable account ledger.

The default model applies hypothetical 1% buy fees, 1% sell fees and 1% adverse baseline price slippage. Buy prices increase and sell prices decrease; an explicit estimated impact can add further adverse slippage. Without pool reserves/order-book depth, no liquidity-derived curve is invented. Gross order notional must fit the explicitly observed liquidity and the default 1% participation cap. This is a simplified research model, not a claim about current fees, obtainable fills or Solana execution.

Observations must be reliable USD quotes, received by the decision time, no older than 15 seconds and healthy. Missing price/liquidity, incompatible side/pool, zero liquidity, exceeded participation, insufficient cash/holdings, simulated transaction failure and partial-order requests fail closed. Simulated failures charge no fee; network failure fees, priority fees and rent are not modeled. Small protective exits may use less than the entry minimum; a zero-notional/dust result is rejected and remains unresolved.

Orders distinguish request, `CREATED`, `SUBMITTED`, and terminal `FILLED`/`FAILED`. The transition path, request, configuration, observation, fill or error are journalled. Full simulation and settlement happen atomically, so pending orders are not exposed across transactions. Cancellation of an already completed operation and partial **order fills** are unsupported in this engine. Staged partial **position exits** are supported: each sell is a separate fully filled or failed smaller order. The earlier Week 1 fixture runner still supports its original test-only partial-fill scenarios.

### Position monitoring and exit precedence

A position records original and remaining quantity, actual entry fill price, fee-inclusive entry cost basis, marks and timestamps, target flags, trailing peak, fees, realized P&L and any pending blocked exit. The existing `positions.status` retains OPEN/CLOSED compatibility; `paper_state` distinguishes OPEN, EXIT_BLOCKED and CLOSED. A new purchase has no sell-side quote yet: its initial gross entry notional is only a provisional book value, clearly marked stale/uncertain until a fresh sell observation arrives.

Exit rules use the modeled sell-side price before fees and the actual buy fill price as entry reference. Defaults:

- Stop-loss: attempt to sell all remaining quantity at or below 75% of entry.
- First profit target: at +60%, sell 33.3333% of the original quantity, rounded down.
- Second target: at +150%, sell 50% of the quantity remaining after the first successful target.
- Trailing phase: activate only after the second target fills. Start the peak at that observation's modeled sell price, then update it only from subsequently received valid sell observations. Attempt the remaining exit at a 30% decline from that peak.
- Maximum holding time: attempt a full exit after 60 minutes when a fresh executable observation arrives.

Priority is current critical token-risk rejection, stop-loss, trailing stop, maximum holding time, retry of a pending blocked exit, then the next take-profit target. Only one sell is attempted per observation; a price jump through both profit targets requires a subsequent observation for target two. A failed sell retains its pending intent for retry on fresh data. Protective exits remain enabled when daily risk controls block entries or the account is HALTED. No stop, halt, expiry or risk rule guarantees execution or limits an actual loss.

Missing/stale/unhealthy observations preserve the last valid mark, mark valuations stale, stop new entries and do not claim a fill. Recovery restores target completion and trailing state from persisted events. A position becomes CLOSED only after its entire remaining quantity has a recorded sell fill.

### Accounting and persistence

All authoritative money and quantity calculations use decimal strings and BigInt. Currency uses 18 decimal places; simulated token quantities default to nine, configurable up to 18. This is an explicit research precision policy, not a statement about an on-chain mint's decimals. Buy price/notional and fees round upward to one USD atomic unit; sell price/notional and quantities round downward. Budget search uses these same boundaries. No quantity is rounded up to spend extra cash.

Entry cost basis includes the buy notional and buy fee. A partial exit allocates remaining basis in proportion to sold/held quantity, rounding allocated basis down; the final exit takes the entire residual. Realized P&L is net sell proceeds minus allocated basis. Unrealized P&L uses estimated net sell value minus remaining basis. Actual buy/sell fees are tracked separately, without deducting them twice. Equity equals available cash plus reserved cash plus position marks. Marks and hypothetical net proceeds do not establish that liquidation is possible; liquidity uncertainty is stored separately.

Each order reserves its exact estimated all-in buy cost, then atomically settles or releases it. Ledger postings explicitly record available/reserved changes, fill costs, realized P&L and fees. The invariant `cash + reserved + remaining cost basis = initial bankroll + realized P&L` is checked independently of strategy logic. Fees and equity do not use JavaScript floating-point arithmetic.

Daily loss measures the decline from the first processed UTC-day baseline (the previous known marked equity) to current marked equity; positive gains do not create a daily realized-loss allowance. At a 3% daily loss, entries are disabled while existing positions remain monitored. Total drawdown measures decline from peak marked equity; reaching 10% latches HALTED. Stale valuations remain labelled and prevent entries. These controls cannot guarantee liquidation value or a maximum realized loss.

Migration `0006_paper_trading.sql` adds `paper_portfolios` and append-only `portfolio_balance_events`, and extends the existing orders, trades and positions with account links, execution evidence, exact notional and exit state. It adds no duplicate order/trade tables. Composite foreign keys enforce account ownership; unique keys prevent duplicate candidates/fills and concurrent active positions. Deferred PostgreSQL triggers require matching fills and ledger evidence for paper orders, reconcile cash against postings, and reject ledger edits. Existing Week 1–4 rows remain valid. Fictional instruments are registered with `tokens.source_platform='PAPER_FIXTURE'` and UNKNOWN risk solely to satisfy the existing order/token foreign keys; they never replace canonical risk assessments or existing token metadata.

Every account operation locks its portfolio row with `FOR UPDATE`. The pure accounting/exit reducer, financial rows, order evidence, ledger event and snapshot commit together or all roll back. Journal events form a hash chain. Restart recovery takes a consistent locked snapshot, verifies the chain, replays every command and posting, compares the resulting portfolio, and checks materialized order/fill/position records. Conflicting reuse of an event ID fails rather than executing a second trade.

### Inspect PostgreSQL records and verify

```sql
SELECT id, name, status, available_cash_usd, reserved_cash_usd, equity_usd,
       state->>'realizedPnlUsd' AS realized_pnl,
       state->>'buyFeesUsd' AS buy_fees, state->>'sellFeesUsd' AS sell_fees
FROM paper_portfolios ORDER BY created_at DESC;

SELECT id, portfolio_id, side, status, requested_quantity, actual_fees_usd,
       paper_details->>'reason' AS reason,
       paper_details->>'failureReason' AS failure
FROM orders WHERE portfolio_id IS NOT NULL ORDER BY created_at;

SELECT portfolio_id, token_mint, paper_state, quantity, cost_basis_usd,
       realized_pnl_usd, unrealized_pnl_usd, paper_details->>'blockedReason'
FROM positions WHERE portfolio_id IS NOT NULL;

SELECT portfolio_id, sequence, timestamp, command->>'type' AS command,
       postings, result
FROM portfolio_balance_events ORDER BY portfolio_id, sequence;
```

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

Tests cover conservative arithmetic, fee-aware sizing, risk gates, replay identity, stale/future observations, failed liquidity exits, staged cost-basis allocation, trailing/exit priority, account loss limits and explicit reset, partial-position recovery, atomic rollback, materialized-record reconciliation and concurrent duplicate entries on independent database connections. Integration fixtures roll back; the concurrency test creates and removes its own isolated schema without leaving shared test records.

Week 6 can build controlled backtest datasets, richer pool-impact/network-cost models and systematic accounting comparisons on this ledger. Forward feed integration, partial-order execution, realistic failure/network costs and verified venue fill modeling remain outside the implemented simulation. Simulated gains do not demonstrate that the same trades could execute on-chain at the same prices.

## Week 6 — Historical Backtesting

Week 6 adds chronological, event-driven backtesting on the existing Week 4 strategy and Week 5 paper accounting/executor. It does not add a separate financial simulator. All activity remains **PAPER ONLY**, with no wallet, signing, swaps, live order submission or paid data providers.

### Data readiness and supported sources

The operational data audit found 32 PumpPortal discovery events (27 launches, five migrations), with no blockchain event timestamps or slots, and 76 historical risk assessments. Existing individual trades/candles are explicitly fixture data. Discovery and occasional enrichment do not supply continuous historical trading coverage or execution liquidity. **The operational real dataset is insufficient for a real historical strategy backtest.** Counts and ranges are read fresh by the audit command; they may grow as discovery runs.

```bash
pnpm backtest --dataset historical
```

This command exports `reports/backtests/historical-data-audit/audit.json` and `report.md`, reports `HISTORICAL_DATA_INSUFFICIENT`, and exits with code 2. It performs no backtest and never silently substitutes synthetic observations. The audit separates source classes, ingestion times, absent event times/slots, risk history, fixture trades/candles, gaps and missing execution information. It does not apply current token metadata to past dates.

Supported replay sources are:

- Bundled, clearly labelled synthetic datasets: `fixtures`, `fixtures-winner`, `fixtures-zero-trade`.
- A validated `SOLEMN_HISTORY_V1` JSON file, bounded to 10 MiB and 100,000 inline events by the CLI. Its manifest declares source kind, provenance, dataset/version, historical bounds, market scopes and pool-creation availability. `HISTORICAL` imports are user-supplied historical evidence, not independently verified data.
- Registered PostgreSQL datasets selected by UUID or `postgres:UUID`. `PostgresHistoricalDataProvider` uses indexed keyset pagination, with at most 1,000 events per page. The repository's streaming registration API supports bulk iterables without loading their entire event history into memory.

Normalized envelopes support individual trades, minute coverage/gaps, historical risk contexts, explicit execution observations, discovery and unknown source observations. Imports validate Solana addresses, financial strings, scope, timestamp consistency and format. Exact adjacent duplicates are filtered and counted; conflicting source identities fail the import. Dataset versions and their canonical content fingerprints are immutable after publication.

The quality report includes tokens/events/trades, observation ranges, missing timestamps/prices/liquidity/security, duplicate events, gaps, missing minute coverage, uncertain ordering and tokens without ten complete priced minutes. Source-dataset quality and selected-run-range quality are exported separately. The replay still applies the actual strategy gates: a broad dataset quality summary never substitutes for per-decision readiness.

### Run a backtest

With PostgreSQL running and migrations applied:

```bash
pnpm db:migrate
pnpm backtest --dataset fixtures --strategy SOLEMN_LAUNCH_MOMENTUM_V1
pnpm backtest --dataset fixtures-winner
pnpm backtest --dataset fixtures-zero-trade
```

The default six-scenario dataset contains:

1. A momentum entry followed by staged take-profit and trailing exits.
2. A valid entry followed by a stop-loss, filled from the later execution quote.
3. A rising position whose liquidity disappears; its attempted exit fails and exposure remains unresolved.
4. An unsafe token rejected before entry.
5. A token with missing market coverage and USD observations.
6. A lookahead trap with later price/security information that cannot approve earlier trades.

The combined dataset intentionally ends with uncertain open exposure. Its final reliable equity, unrealized P&L and total net return are **unavailable**, rather than treating the unresolved position as worthless or fully recoverable. The winner-only dataset demonstrates a fully closed account, while the zero-trade dataset illustrates undefined trade ratios and the unchanged no-trade baseline. All three are fictional research scenarios, not actual historical performance.

CLI options:

| Option                | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `--dataset`           | Bundled source, registered UUID, JSON path, or operational `historical` audit                             |
| `--start`, `--end`    | ISO timestamps or `YYYY-MM-DD`; must exist within the dataset and align to UTC minutes                    |
| `--strategy`          | `SOLEMN_LAUNCH_MOMENTUM_V1`                                                                               |
| `--initial-balance`   | Exact positive USD string; defaults to the existing paper policy's $100                                   |
| `--latency-ms`        | Execution delay; defaults to 1,000 ms                                                                     |
| `--wait-ms`           | Wait after the scheduled execution time for a usable quote; defaults to 30,000 ms                         |
| `--equity-cadence-ms` | Equity/clock-tick cadence; defaults to 60,000 ms                                                          |
| `--batch-size`        | Event-page and same-time cohort bound, 1–1,000                                                            |
| `--max-events`        | Explicit event/work limit, up to 1,000,000; replay timers and market evaluations also consume this budget |
| `--output-dir`        | Output root; defaults to `reports/backtests`                                                              |
| `--run-id`            | Optional UUID for a distinct experiment with otherwise identical economics                                |
| `--config`            | Validated JSON options; CLI arguments override file values                                                |
| `--verbose`           | DEBUG per-event logs; INFO remains run/signal/report oriented                                             |
| `--help`              | Print usage without opening a database connection                                                         |

Example configuration file:

```json
{
  "dataset": "fixtures-winner",
  "initialBalanceUsd": "100",
  "executionLatencyMs": 1000,
  "executionWaitMs": 30000,
  "equityCadenceMs": 60000,
  "batchSize": 1000,
  "outputDirectory": "reports/backtests",
  "tradingMode": "PAPER"
}
```

The file can also contain complete validated `strategy`, `paper` and `risk` policy objects. Otherwise the existing environment policies are reused. Historical assessments must match the selected risk policy and remain fresh/current; a policy mismatch blocks eligibility instead of silently approving an old assessment. Unknown conditions remain unknown. Requested dates outside the dataset, unsupported modes, invalid costs/limits or missing datasets fail rather than falling back.

No background backtest runs on worker startup. `pnpm backtest` is an explicit local CLI operation; no `BACKTEST_ENABLED` switch or additional network service is needed.

### Ordering, clock and no-lookahead rules

`SimulationClock` advances directly through historical availability times and scheduled timers, without real-world sleeping. Core strategy, risk, paper execution, cooldowns, daily windows, holding limits and exit rules receive that historical time through their existing explicit `asOf`/`at` arguments. `SystemClock` is available for normal runtime. Real-world run creation/completion metadata is separate from economic timestamps.

The primary event order is **information availability**, followed by event time, semantic event priority, supplied slot/transaction/provider indexes and stable identity. SQL and JavaScript use matching bytewise canonical ordering. A signature is not treated as a transaction index. A whole bounded availability-time cohort is ingested before candle decisions at that instant. Conflicting same-time execution quotes without sufficient sequencing are marked unusable; the reused candle builder also conservatively rejects conflicting same-time trade prices rather than inventing an OHLC order; technical ID ordering does not pretend to resolve real market order. The historical clock supports millisecond precision and rejects finer availability timestamps.

One-minute candles finalize at their existing end-plus-lateness cutoff. The engine retains only the recent sixteen candles and a bounded observation window, preserving prior finalized candles. Late data becomes correction evidence and invalidates affected future windows; it does not rewrite earlier signals. Pool creation must be known by the decision time. Risk contexts are updated only when their availability timestamp is reached, and older arriving assessments cannot override a newer request.

Execution uses a scheduled intent. Entries and exits must wait for an observation received after the trigger, at or after the configured delay, with an observation timestamp at or after the scheduled execution time. Even zero configured latency requires a later observation. The triggering candle close or an earlier stored quote cannot automatically become a fill price.

The Week 5 reducer has an optional deferred-execution mode for marks. It records the exit intent without selling; a later eligible quote uses the same executor and settlement rules. A newly observed higher-priority exit supersedes and reschedules the intent. Missing execution observations produce persisted EXPIRED/UNFILLED intent records, without fictional fills. An unavailable exit remains unresolved. Failed exits can retry on a later quote after the delay; replay end does not force liquidation at an old price.

The model reuses Week 5 buy/sell fees, adverse slippage, minimum quantity/notional and liquidity participation limits. Fees and price-impact approximations remain explicit research assumptions. Pool-depth curves, priority/rent/failure-network fees and advanced stress scenarios are deferred to Week 7.

### Isolation, accounting and recovery

Each run has its own strategy-run identity, portfolio, decisions, orders, fills, positions and journal. Existing operational scanner events, raw historical market rows, risk history and worker account balances are not overwritten. Original imported inputs live in a separate immutable dataset store. Existing `FIXTURE`-labelled strategy/paper contracts remain the counterfactual execution container; authoritative input provenance is the backtest plan/manifest's `SYNTHETIC` or `HISTORICAL` source kind, displayed in every report.

The default run UUID derives from the dataset fingerprint, selected range, policies, execution assumptions and engine version. The exact plan is persisted. A completed identical command returns the same recorded result; `--run-id` allows an independent isolated rerun. An incompatible plan cannot reuse an existing run ID. Published inputs, result rows and equity snapshots are immutable.

Interrupted runs reconstruct strategy state and the scheduler from the frozen source. Paper commands retain stable identities. The historical reconstruction advances from each original command's expected state rather than feeding a later current balance into an earlier decision. Existing fills are verified and skipped, so restart after a staged partial exit does not reset targets, trailing state or cash. Week 5 recovery still verifies the hash chain and materialized financial records. Financial transactions keep the existing row lock and atomic reservation/fill/ledger guarantees.

Migration `0007_historical_backtesting.sql` adds `backtest_datasets`, `backtest_dataset_events`, `backtest_runs`, `backtest_equity_snapshots`, `backtest_execution_intents` and `backtest_results`. Migration `0008_historical_replay_order_index.sql` indexes canonical bytewise replay order. Financial history uses the existing orders/trades/positions through the backtest run's unique portfolio association; there is no duplicate accounting engine.

### Metrics, equity and reports

Performance analysis records starting/ending cash, reliable marked equity, realized/unrealized P&L, net return, reliable peak equity, maximum observed drawdown, fees and modeled slippage. It also counts orders/failures, entries/exits, closed/open positions, maximum concurrent positions and strategy/data rejection paths.

Closed-position statistics include wins, losses, break-even positions, win rate, arithmetic mean winning/losing returns, average winning/losing P&L, expectancy per closed position, median return, largest win/loss, profit factor and average holding duration. Open positions never become closed winners. Win rate uses all closed positions, including break-even positions. Profit factor uses positive/negative **closed-position net P&L**, not gross sell proceeds; it is explicitly undefined if there are no losing closed positions. Empty denominators remain unavailable. Monetary sums use exact BigInt arithmetic; displayed percentage statistics truncate at 18 decimal places.

Equity snapshots are generated at the configured cadence and after portfolio changes. Cash and realized P&L remain known when marks are stale. Marked positions, total equity, unrealized P&L and drawdown become null when valuation is unreliable. CSV fields are empty in that case. Maximum drawdown is measured over reliable historical snapshots, with an explicit incomplete-coverage flag if any valuations were uncertain; it is not presented as a guaranteed full-period loss bound.

Each run exports:

- `report.md`: readable summary, baseline comparison, evidence links and limitations.
- `result.json`: exact plan, provenance/fingerprint, metrics and final account state.
- `data-quality.json`: full-source and selected-range data-quality reports.
- `metrics.csv`: all metric values, with undefined values left empty.
- `equity.csv`: historical equity curve and valuation-quality reasons.
- `orders-and-fills.csv`: requests, failures, individual buys/sells, fees, slippage, per-exit P&L and holding time.
- `positions.csv`: closed and unresolved positions, remaining quantities/basis and blocked-exit reasons.
- `execution-intents.csv`: signal/trigger time, due time, observation, result and missed-execution evidence.

Reports are generated under `reports/backtests/RUN_UUID/` and ignored by Git. Larger equity/order/intent exports stream in bounded database pages. The no-trade baseline retains the exact same initial bankroll with zero orders or fees. Baseline excess equity is unavailable when strategy equity is unreliable. No annualized returns, Sharpe ratios or statistical-significance claims are made for these small datasets.

```sql
SELECT id, status, dataset_id, portfolio_id, plan->>'startTime' AS start_time,
       plan->>'endTime' AS end_time FROM backtest_runs;
SELECT run_id, payload->'metrics'->'portfolio' AS portfolio_metrics
FROM backtest_results;
SELECT run_id, timestamp, total_equity_usd, valuation_quality
FROM backtest_equity_snapshots ORDER BY run_id, timestamp;
SELECT run_id, status, payload->>'reason' AS reason
FROM backtest_execution_intents;
```

### Verification and next milestone

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

Local tests cover event ordering and duplicate filtering, missing timestamps/source data, paginated histories, clock/range validation, all six scenarios, delayed entry/exit scheduling, no-lookahead traps, uncertain terminal positions, exact accounting/metric denominators, result and equity reproducibility, report exports, restart after a persisted partial exit, and isolation from worker accounts and raw history. Normal tests call no live blockchain providers.

A profitable backtest does not guarantee profitable live trading. Dataset quality, publication delays, selection/survivorship bias, costs and liquidity can materially change outcomes. Real-history collection/import quality remains the main limitation. Week 7 can extend pool-level execution modeling and failure/liquidity stress tests on this same replay and ledger foundation.
