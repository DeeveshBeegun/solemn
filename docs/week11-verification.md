# Week 11 verification

Solemn remains paper-only. Week 11 changes forward operational authorization and leaves isolated backtests and the paper execution model on their existing paths.

## Initial assessment and implemented changes

The existing forward worker used a dedicated PostgreSQL advisory-lock connection, a persisted replay cursor, immutable ledger events and deterministic recovery. Administrative state lived partly in the runtime account and partly in the financial snapshot. The repository did not enforce the runtime pause at its final entry boundary. A pool release could return a connection with its advisory lock still held.

| Files                                                                                                                                                    | Change                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/operations/`                                                                                                                            | Transition rules, atomic controls, kill switch, append-only audit, incident deduplication, read-only reconciliation and local CLI.                                                          |
| `apps/worker/src/monitoring/`                                                                                                                            | Market evidence classification, database connectivity and migration-compatibility probe, and recorded activity metrics.                                                                     |
| `apps/worker/src/security/securityPolicy.ts`, `apps/worker/src/config/index.ts`, `.env.example`, `apps/worker/src/services/logger.ts`                    | Paper-only configuration checks, health thresholds and authorization-header redaction.                                                                                                      |
| `apps/worker/src/forward/account.ts`, `replayCoordinator.ts`, `liveProvider.ts`, `forwardTradingService.ts`, `monitor.ts`, `cli.ts`                      | Shared state enforcement, ownership lifecycle, readiness checks, session recovery and legacy CLI routing.                                                                                   |
| `packages/database/src/client.ts`, `forwardOwnership.ts`, `paperRepository.ts`, `forwardSchema.ts`, `operationsSchema.ts`, schema and repository exports | Dedicated-session verification, account locking before financial state updates, and persistence. The final entry check requires an owned session and current verified operational evidence. |
| `packages/database/drizzle/0014_forward_operations.sql`, Drizzle journal and snapshot                                                                    | Adds control and health fields to the forward account, preserves existing holds, and creates incident and immutable audit tables.                                                           |
| `apps/worker/tests/operations.test.ts`, `forwardTrading.integration.test.ts`, `analytics.integration.test.ts`                                            | Operational unit and failure-injection tests, plus ownership setup for existing integration paths.                                                                                          |
| `package.json`, `README.md`, `docs/operations/runbooks.md`, `docs/security/threat-model.md`, `docs/security/future-signing.md`                           | Local commands, operating procedures and security review inputs.                                                                                                                            |

The first forward test pass exposed a behavior regression. The strategy had been waiting for an executable quote before recording an intent, but the fixture provides that quote after the signal. The implementation now allows a candidate to await a quote under eligible market conditions. It still requires a supported fresh quote and `RUNNING` at the final entry boundary.

## Incident exercise

The integration scenario used the existing $100 synthetic replay. It created an open position, recorded a 65-second disconnect and marked the exposure stale. The test injected a journal write failure and verified that the financial snapshot was unchanged after rollback. It then latched an emergency halt while the position remained open, restarted the worker, and used fresh observations for protective exits. Reconciliation recovered four orders and four fills, with $101.098514 cash and $1.098514 realized paper P&L. Rerunning the completed cursor left the ledger identical.

The tests also exercised pause at the repository gate, a valid resume, repeated halt deduplication, an authorized halt reset through `RECOVERING`, failed persistence before an entry lands, ownership conflict, unclean owner recovery, corrupted pending exits, immutable audit records and ordinary resume rejection while halted.

## Local CLI drill

The development drill used the separate `week11-validation` replay account and independent worker processes. It made no external provider requests.

| Evidence                          | Result                                                                   |
| --------------------------------- | ------------------------------------------------------------------------ |
| Portfolio                         | `77bc29ac-cd73-81cc-ae84-a37855964f74`                                   |
| Pause                             | `PAUSED`, version 13                                                     |
| Emergency halt and retry          | `HALTED`, version 14 on both calls                                       |
| Generic resume                    | Rejected                                                                 |
| State after worker restart        | `HALTED`, entry gate closed                                              |
| Reconciliation before and after   | `PASS`, identical snapshots                                              |
| Journal / orders / fills          | 255 / 4 / 4                                                              |
| Virtual cash / realized paper P&L | $101.098514 / $1.098514                                                  |
| Incident evidence                 | One active administrative halt alert and two market-data outage episodes |

The development account was left halted after the drill. To inspect it, run `FORWARD_ACCOUNT=week11-validation pnpm solemn:health`, `solemn:incidents` or `solemn:reconcile` with the same account selection.

## Commands and results

| Check                   | Result                      |
| ----------------------- | --------------------------- |
| `pnpm typecheck`        | Passed                      |
| `pnpm lint`             | Passed                      |
| `pnpm test`             | 359 passed across 30 files  |
| `pnpm test:integration` | 64 passed across 12 files   |
| `pnpm build`            | Passed                      |
| `pnpm db:migrate`       | Applied locally             |
| `pnpm db:generate`      | No remaining schema changes |
| `git diff --check`      | Passed                      |

## Week 12 review limits

The kill switch applies to forward paper portfolios. Backtests and standalone fixtures remain isolated research paths. The live collector cannot reach `RUNNING` until executable market evidence is supported. Notification delivery, Telegram, delivery retries, infrastructure cost attribution and per-provider latency and request metrics remain deferred. Alerts are durable local incident records with one active alert per category. A failure while PostgreSQL is unavailable can be logged locally, with the previous owned-session marker latching a halt during recovery.

The account row and operational audits assume trusted PostgreSQL administration. Local access and database roles still need a formal privilege-separation review. A duplicate process is denied the lock even if it races before the first worker has created an account. In that bootstrap window there is no account to attach the incident to, so the conflict is logged locally. Operational verification provides inputs for the Week 12 paper-system review. It does not establish readiness for live trading.
