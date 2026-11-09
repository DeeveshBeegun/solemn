# Week 10 verification

Solemn remains paper-only. The Jupiter path is an explicit observer that keeps quote and diagnostic evidence separate from the paper ledger. The existing strategy, risk thresholds and paper execution model are unchanged.

## Implemented scope

| Files                                                                                                                                                      | Changes                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/execution/jupiter/amounts.ts` and `jupiterClient.ts`                                                                                      | Exact integer token amounts, configured decimals, documented routing preferences, lossless response parsing, authentication, bounded retries and rate limiting. The client sends only `GET /swap/v2/order`. |
| `apps/worker/src/execution/jupiter/quoteValidation.ts` and `apps/worker/src/execution/feeEstimator.ts`                                                     | Independent minimum-output, slippage, fee, impact and freshness checks. Preserves estimated network costs, payer metadata and potentially recoverable rent separately from embedded route costs.            |
| `apps/worker/src/execution/executionReadiness.ts`                                                                                                          | Reuses the paper entry risk check. Validates evidence and available allocation, compares a same-input Week 7 pool quote where available, and persists decisions independently of paper fills.               |
| `apps/worker/src/execution/jupiter/transactionInspector.ts` and `transactionSimulator.ts`                                                                  | Static unsigned inspection, checked fee payer and signer, supported shared-route account roles, and optional read-only block-height and simulation RPC calls.                                               |
| `apps/worker/src/execution/jupiter/cli.ts`, `package.json`, `.env.example`, `apps/worker/src/config/index.ts` and `apps/worker/src/analysis/httpReader.ts` | CLI commands, explicit opt-ins, endpoint validation, and shared HTTP limits.                                                                                                                                |
| `packages/database/src/swapAuditSchema.ts`, `swapAuditRepository.ts`, schema exports and migration `0013_swap_execution_assessments.sql`                   | Append-only assessment records with quote, signal and portfolio references, fingerprints, validation and diagnostic findings. Includes the Drizzle snapshot and journal entry.                              |
| `apps/worker/tests/jupiterFixtures.ts`, `jupiterSwap.test.ts`, `jupiterSwap.integration.test.ts`                                                           | Offline client and RPC tests, deterministic entry evidence, loopback server and PostgreSQL integration.                                                                                                     |
| `README.md` and this report                                                                                                                                | Commands, operating boundaries, verification results and Week 11 work.                                                                                                                                      |

## Live quote smoke test

The initial direct keyless request returned HTTP 200 with a JupiterZ quote and no transaction. The first CLI attempt uncovered an omitted optional slippage field that failed canonical request hashing before a provider call. The request schema now omits unset fields and a regression test covers that path.

After the fix, the new CLI requested a separate keyless quote with the taker omitted. It recorded the following observation and read back the same stored row with the readiness command.

| Field                       | Observed value                                           |
| --------------------------- | -------------------------------------------------------- |
| Assessment ID               | `7bf5faef-6e47-8cd5-a4a0-f182d1d726b8`                   |
| Quote ID                    | `91fedeed-3fe2-824c-a1aa-bae579e01bf6`                   |
| Received UTC                | 2026-11-09 10:10:27.729                                  |
| Request latency             | 862 ms                                                   |
| Router                      | `jupiterz`                                               |
| Input                       | 0.01 SOL (10,000,000 lamports)                           |
| Expected and minimum output | 0.861263 USDC (861,263 base units)                       |
| Effective rate              | 86.1263 USDC per SOL                                     |
| Reported slippage tolerance | 0 bps                                                    |
| Reported aggregate fee      | 2 bps                                                    |
| Reported price impact       | −0.013320015778802739%                                   |
| Provider expiry             | Unavailable                                              |
| Transaction                 | `QUOTE_ONLY`                                             |
| Quote checks                | `QUOTE_CHECKS_PASSED`                                    |
| Overall assessment          | `INSUFFICIENT_DATA`, `SIGNAL_AND_PORTFOLIO_NOT_ASSESSED` |

The result describes a point-in-time quote. There was no live unsigned preparation, RPC simulation, wallet interaction or execution in the smoke test.

The local inspection CLI returned `INSPECTED` for a v0 compute-budget-only fixture. The local simulation CLI returned `UNVERIFIABLE` with `RPC_SIMULATION_DISABLED` and attempted no RPC call.

## Offline integration

The tests generated an actual fixture `BUY_CANDIDATE` using the existing strategy with a $100 paper portfolio. A loopback HTTP server provided an exact-input quote, an unsigned v0 fixture and mocked RPC results. The quote-only path reached `READY_FOR_DRY_RUN`. The preparation path inspected the taker, account roles and matching mints, checked the block height and attempted a read-only diagnostic. Mocked success recorded `SIMULATED` with slot 1,000 and 42,000 units while readiness remained `UNSUPPORTED` because CPI and token accounts were unverified. The failure scenario recorded a custom instruction error and readiness `REJECTED`. Expired quotes, stale risk evidence, stale market data and oversized allocation also took their expected failure paths.

The integration checks verified a single immutable audit row per scenario, unchanged paper ledger snapshots, and zero paper orders, trades or positions. They checked the captured HTTP method, URL path and RPC method and verified that a loopback service received no API key. Transaction bytes and arbitrary provider text did not enter the audit record. None of these mock results imply real fill quality.

## Commands and results

| Check                   | Result                      |
| ----------------------- | --------------------------- |
| `pnpm typecheck`        | Passed                      |
| `pnpm lint`             | Passed                      |
| `pnpm test`             | 340 passed across 29 files  |
| `pnpm test:integration` | 61 passed across 12 files   |
| `pnpm build`            | Passed                      |
| `pnpm db:migrate`       | Applied locally             |
| `pnpm db:generate`      | No remaining schema changes |
| `git diff --check`      | Passed                      |

## Security boundary and remaining work

The Swap client constructs one fixed order endpoint and rejects redirects. The simulator rejects Jupiter domains and can call only `getBlockHeight` and `simulateTransaction`. Signature verification is disabled and the original blockhash is retained. The inspector rejects nonzero signatures and extra signer slots before RPC. It supports static v0 and legacy layouts and recognizes only a narrow set of instruction shapes. Lookup tables, v1, sponsored payers, direct token and SOL instructions, ATA setup and unrecognized routes require additional review. Static checks do not verify destination ownership, route amounts encoded in CPI, or all balance changes. A successful quote or simulation does not guarantee that a real transaction will execute at the quoted price.

Genuine forward signals and executable pool observations are still unavailable in Solemn. The entry-readiness service therefore restricts the end-to-end strategy path to loopback fixtures. Live quote research remains independently available. Week 11 can connect verified live evidence and improve address lookup, token-account and instruction validation. Signing and broadcasting require a separate authorized security milestone.

Primary references verified for this milestone include Jupiter's [Swap V2 overview](https://developers.jup.ag/docs/swap), [order and execute workflow](https://developers.jup.ag/docs/swap/order-and-execute), [order reference](https://developers.jup.ag/docs/api-reference/swap/order), [execute reference](https://developers.jup.ag/docs/api-reference/swap/execute), and [rate limits](https://developers.jup.ag/docs/portal/rate-limits). The unsigned diagnostic follows Solana's [transaction structure](https://solana.com/docs/core/transactions/transaction-structure), [block height](https://solana.com/docs/rpc/http/getblockheight) and [simulation](https://solana.com/docs/rpc/http/simulatetransaction) references.
