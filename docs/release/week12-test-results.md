# Week 12 executed checks

The baseline ran before the release fixes. `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` and `pnpm build` all exited 0. It included 359 unit tests and 64 integration tests.

The initial read-only inventory found four older fixture ledgers that the baseline tests did not cover. Diagnostic comparison found differences limited to execution-audit references. After the scoped compatibility fix, all 17 existing development portfolios reconciled from 7,726 ledger events and matched 202 materialized orders and 98 fills. Fourteen open positions remained recorded. The audit performed no writes to the development ledgers. The regression test confirms altered reserves still fail reconciliation.

The first extended integration attempt failed because its scanner fixture was disabled. The fixture now starts the scanner explicitly with an offline transport, and the test checks that a persisted assessment actually reaches the accepted signal. A test helper initially used incorrect fill field names and was corrected. The first release command attempts also caught a Node JSON import error and missing Node globals in the script's lint configuration. Those were corrected before the final gate.

The legacy regression initially exceeded the unit runner's five-second default while the larger fixture suite was running concurrently. Its fixture now uses one market and still verifies both audit shapes and the corrupted-reserve rejection. The focused recovery and provider tests then passed 35 checks across four files.

A repeated release gate showed that its first smoke implementation had left fixture rows in the reusable test database. The smoke now creates a uniquely named scratch database and removes only that scratch instance. Tests that counted unrelated rows were scoped to their own order or token, and the metered mock uses a separate mint. Existing test data was preserved.

The focused rerun on the reused database passed all three previously colliding tests. Its filter skipped 25 unrelated tests. The final release gate ran the full suites separately.

## Final release gate

`pnpm release:verify` exited **0** on a fresh disposable PostgreSQL 16 container. The generated machine-readable summary is `reports/release/verify-YWk6td/summary.json`. The per-command logs are in the same directory.

| Check                                        | Exit | Result                                                     |
| -------------------------------------------- | ---: | ---------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             |    0 | Locked dependency install                                  |
| `pnpm typecheck`                             |    0 | Source and test types                                      |
| `pnpm lint`                                  |    0 | ESLint and Prettier                                        |
| `pnpm test`                                  |    0 | 362 passed across 31 files                                 |
| `pnpm test:integration`                      |    0 | 65 passed across 12 files                                  |
| `pnpm build`                                 |    0 | Production build                                           |
| `pnpm release:smoke`                         |    0 | Compiled worker, isolated fixture replay, halt and restart |
| `pnpm --filter @solemn/database db:generate` |    0 | No schema changes                                          |
| `git diff --check`                           |    0 | No whitespace errors                                       |

The full unit and integration runs reported no skipped tests. A second smoke on the same fresh PostgreSQL instance left zero portfolios in the integration database and zero scratch databases, matching the counts before the repeat.

## Failure matrix

| Scenario                      | Expected and observed behavior in the named check                                                                    | Recovery and audit evidence                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| WebSocket disconnect          | Scanner transport and forward incident integration record the gap and block new entries.                             | Replay retains the open position and allows supported protective exits after reliable observations return.      |
| Extended stale market data    | Feed-health and incident tests reject stale evidence and report uncertain equity.                                    | Gap and outage remain in history. Recovery requires fresh observations and completed indicators.                |
| Jupiter API outage            | Swap client tests bound timeouts and rate-limit handling and return explicit unavailable evidence.                   | No quote or order is fabricated. Standalone failures can be persisted in the swap audit.                        |
| Solana RPC timeout            | Risk RPC timeout test returns unknown mint evidence and a safe timeout code.                                         | Fresh read-only observations are required to approve risk.                                                      |
| Database disconnect           | Forward test terminates its owned PostgreSQL backend. The old lease aborts and its next query fails.                 | A new dedicated session acquires the lock. The separate unclean-start test latches the recorded owner incident. |
| Database transaction failure  | Injected paper frame and journal failures roll back and preserve balances.                                           | A halt is recorded when the database is reachable. The cursor and financial state remain reconcilable.          |
| Duplicate market events       | Release scanner test delivers the same discovery twice.                                                              | One market event and one token are stored, with a duplicate counter.                                            |
| Duplicate trading signals     | Concurrent paper persistence and repeated forward cursor tests prevent a second fill.                                | The original order and ledger event remain authoritative.                                                       |
| Duplicate worker              | Independent PostgreSQL connections compete for the same advisory lock.                                               | One owner succeeds, and ownership can be reacquired after release.                                              |
| Portfolio ledger mismatch     | Legacy compatibility test rejects changed reserves even after rehashing. Pending-exit corruption test halts startup. | No repair or financial mutation is applied. Recovery requires reconciliation.                                   |
| Failed stop-loss              | Paper and execution scenario tests preserve a blocked or unresolved position and omit sale proceeds.                 | Supported fresh exit evidence is required before closing.                                                       |
| Sudden liquidity removal      | Pool and execution tests reject the unavailable depth.                                                               | Existing holdings and uncertainty remain recorded.                                                              |
| Emergency halt                | Control integration and compiled CLI smoke persist a halt and close the final entry gate.                            | A repeated halt reuses the state revision and incident.                                                         |
| Restart while HALTED          | Incident integration and separate compiled worker processes preserve the halt and journal.                           | No duplicate fill occurs, and eligible protective exits can still proceed.                                      |
| Resume without valid recovery | Control test and compiled smoke reject a generic resume of a halt. Tests also exercise an authorized recovery.       | A reset requires fresh health, active ownership and reconciled exposure, then enters RECOVERING.                |

The combined release fixture uses production scanner, provider clients, risk evaluator, strategy, paper execution, portfolio and reconciliation code. External inputs are synthetic. The test covers partial fills through the simulator suite and partial exits through the combined workflow, and compares two independent fixture portfolios. The fixture's 65-second gap, injected rollback, halt and restart exercise local operational safety.

The lookahead tests change future prices, reserves, risk assessments and candle highs and compare prior decisions and fills. The historical executor cannot borrow a quote before the signal or after the allowed landing window. Stop handling uses the next eligible observation, and the fee and liquidity tests distinguish failed transactions from successful fills.

## Deployment and restore evidence

The local PostgreSQL 16 container started with an empty disposable database. The compiled worker verified PAPER startup and SIGTERM shutdown. The smoke rejected live mode, signing and swap submission configuration. Forward replay produced 255 ledger events, four orders and four fills, and reconciled to $101.098514 virtual cash. After a persisted halt, a second process produced the same reconciliation output. The custom-format backup was restored into a separate database, retained all 15 migrations, and produced a byte-identical reconciliation report. The original development database was never a restore target.

`docker compose --env-file config/release.env.example config --quiet` also passed after adding separate disposable-test placeholders. Compose interpolates those fields even when the test profile is inactive.

The npm advisory queries `pnpm audit --json` and `pnpm audit --prod --json` each exited 0 with zero advisories. The secret-pattern audit inspected tracked history and nonignored worktree files without printing matches. Optional live provider calls, paid subscriptions, hosted CI, live signing and real transaction execution were not part of the release smoke. Genuine live execution validation remains unavailable.
