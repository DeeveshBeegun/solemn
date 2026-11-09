# Week 7 implementation and verification

Verified locally on 8 November 2026 with Node 22.23.4, pnpm 10.34.9 and local PostgreSQL 16. Solemn remains PAPER ONLY.

## Executed checks

| Command/check                                                      | Actual result                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                   | Passed                                                                                                            |
| `pnpm lint`                                                        | ESLint and Prettier passed                                                                                        |
| `pnpm test`                                                        | 278 tests passed across 26 files                                                                                  |
| `pnpm test:integration`                                            | 47 tests passed across 9 files                                                                                    |
| `pnpm build`                                                       | Passed                                                                                                            |
| `pnpm db:migrate`                                                  | Both Week 7 migrations applied to development; integration setup also applied them to the dedicated test database |
| `pnpm db:generate`                                                 | No remaining schema drift                                                                                         |
| `pnpm backtest:stress --dataset fixtures --scenario all --seed 42` | Completed and repeated successfully                                                                               |
| Invalid seed / unsupported scenario CLI checks                     | Both exited with status 1                                                                                         |
| `git diff --check`                                                 | Passed                                                                                                            |

The new execution test file adds 32 unit cases. The database-backed test verifies atomic attempt/fill persistence, exact failure-fee reconciliation, cached replay without duplication, immutable attempts and reuse of a completed run by two different experiments. Existing Week 5/6 tests remain passing.

## Actual synthetic comparison

Report directory: `reports/backtests/stress-d953dced-40b5-88e7-a230-0b1c15ddb582/`.

These figures are synthetic mechanics tests, not historical profitability. Realized P&L excludes unresolved exposure. All four new execution scenarios retain one frozen position, making ending equity and total return UNKNOWN. Maximum drawdown over the full interval is also UNKNOWN; reliable-snapshot lower bounds are available separately in each result.

| Scenario         | Fills / failed attempts |  Known fees USD | Known realized P&L USD | Unresolved positions |
| ---------------- | ----------------------: | --------------: | ---------------------: | -------------------: |
| Idealized        |                   7 / 6 |               0 |  -0.627691834654595639 |                    1 |
| Baseline         |                   7 / 6 |     0.019724792 |  -0.644366792517495447 |                    1 |
| Pessimistic      |                   7 / 6 |     0.043484792 |   -0.66713679183699281 |                    1 |
| Extreme          |                   3 / 3 |        0.054039 |   0.708538210912512794 |                    1 |
| Week 6 reference |                  8 / 58 | 0.0558808893626 |       -0.4060565723026 |                    0 |

The extreme scenario dropped two entries, so its later portfolio differs and its realized P&L can be higher. This does not establish a profitable total return: its remaining liquidation value is unresolved. The Week 6 reference finishes with equity of $99.5939434276974 because its original model ignores the new frozen-transfer constraint. It is diagnostic, not an equally realistic execution estimate.

Baseline trace reviewed:

- Entry occurs after the 00:14:05 signal and simulated quote/landing stages.
- A stop quote sees a $90 pool price. The landing observation sees $8. The minimum-output constraint fails; the included attempt posts exactly $0.00078 of network expense and no token sale.
- A later conservative retry closes that position at the available gap price, realizing $-0.849088 including its costs. A stop trigger did not cap loss at 25%.
- The liquidity-removal position remains held while reserves are zero, then closes at 00:17:01.050 after liquidity returns.
- The frozen position remains `EXIT_BLOCKED` with 0.00242468 tokens and $0.301847207482504553 remaining basis. No fictional sale proceeds are credited.

All cost CSV row counts matched their full audit JSONL records. Repeated execution produced byte-identical comparison CSV, equity curves, positions, orders, costs and full audits. JSON object ordering and flattened metric row ordering can differ between fresh objects and PostgreSQL JSONB retrieval; metric values agree exactly. The database retains 13/13/13/6 attempts for idealized/baseline/pessimistic/extreme, with 7/7/7/3 fills, and all five scenario memberships. No additional attempts, fills or fees were created by cached replay.

The earlier worker portfolios retained their original cash/realized values, and the three previously completed Week 6 results inspected before this work remain present.

## Files created

- `packages/shared/src/execution.ts`: validated pool, fee, native FX, configuration, prepared quote, outcome, context and audit contracts.
- `apps/worker/src/execution/simulation/poolModels.ts`: registry, exact-input/exact-output CPMM, transfer/venue fees, impact and hypothetical reserves.
- `apps/worker/src/execution/simulation/feeModel.ts`: native base/priority calculations and historical conversion.
- `apps/worker/src/execution/simulation/executionSimulator.ts`: quote preparation, sizing, latency totals, repricing, seeded outcomes and slippage checks.
- `apps/worker/src/execution/simulation/executionScenarios.ts`: four versioned research configurations.
- `apps/worker/src/execution/simulation/mark.ts`: executable size-aware liquidation marks.
- `apps/worker/src/backtesting/stressScenarios.ts`: common explicit-reserve fixture tape.
- `apps/worker/src/backtesting/scenarioRunner.ts`: independent replay comparisons and streamed cost/audit exports.
- `apps/worker/src/backtesting/stressCli.ts`: validated stress CLI and persisted experiment memberships.
- `packages/database/src/executionSchema.ts`: attempt and scenario tables.
- `packages/database/drizzle/0009_execution_realism.sql`: additive immutable audit/scenario persistence.
- `packages/database/drizzle/0010_scenario_membership.sql`: permits cached runs in multiple experiments.
- Corresponding `0009_snapshot.json` and `0010_snapshot.json` Drizzle metadata.
- `apps/worker/tests/executionSimulation.test.ts` and `executionPersistence.integration.test.ts`.
- `docs/week7-execution-assumptions.md` and this verification report.

## Existing files extended

- Shared `paper.ts`, `backtest.ts`, `index.ts`: optional execution contracts and incomplete net-performance metrics without changing absent-field Week 6 hashes.
- Worker `paperExecutor.ts`: new simulator adapter while retaining legacy execution.
- Portfolio `portfolioManager.ts`, `positionManager.ts`: failure expenses, exact cost-basis preservation, executable marks and uncertainty handling.
- Backtesting `backtestConfig.ts`, `replayEngine.ts`, `performanceAnalyzer.ts`: immutable run settings, scheduled historical quote capture, latency, pool-state ambiguity checks, bounded retries and cost/outcome metrics.
- Database `paperRepository.ts`, `schema.ts`, migration journal: transactional attempts, configuration/run binding, audit recovery checks and exports.
- Root `package.json` and `README.md`: CLI command and Week 7 documentation.

## Scope, assumptions and Week 8 readiness

The reference constant-product contract is tested; it is not a PumpSwap or bonding-curve implementation. Fees embedded in AMM flows are separated for reporting and charged once. Native costs require historical conversion; unknown or ambiguous costs halt automatic execution and make net USD metrics null. Supplied account setups use existing token accounts; nonzero recoverable rent is explicitly rejected rather than incorrectly expensed.

Unsupported models remain Pump.fun, PumpSwap, CLMM, DLMM and multi-hop. Historical fee/transfer-epoch discovery, nonzero rent assets, block-height-driven expiry/finality reconciliation, transfer hooks and market feedback are deferred. Failure probabilities are research assumptions, and native funding uses the documented historical-rate just-in-time funding convention. Operational history lacks verified reserve data, so no real-history performance conclusion is available.

See [the complete assumptions and official research sources](week7-execution-assumptions.md). Week 8 can add verified program-specific historical reserves, fee schedules and observed transaction comparisons on top of the tested paper execution/ledger interface. No live trading capability is included.
