# Week 8 forward paper trading verification

Verified on 9 November 2026 with Node 22.23.4, pnpm 10.34.9 and local PostgreSQL 16.

**Forward replay is READY. Live forward paper trading is NOT_READY.** The live collector has been verified against an offline mock transport. A genuine read-only market session with sufficient verified strategy and execution evidence remains outstanding. Every execution path in this milestone is paper-only.

## Readiness assessment

| Required input                                       | Existing source and result                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real-time discovery and migration                    | Existing PumpPortal scanner and immutable event IDs. Both are available through the free data subscriptions.                                                                               |
| Individual trades, side, amounts and trader identity | The live adapter can collect explicitly enabled metered buy/sell messages. It preserves exact amount strings and any explicit source fields for research.                                  |
| Block time, ordering and observation continuity      | Missing or unverified for live strategy use. Local receipt time and connection uptime cannot establish these fields.                                                                       |
| Pool creation time, liquidity and executable depth   | Jupiter supplies aggregate risk evidence. The supported Week 7 reference CPMM requires independently identified reserve observations. Pump.fun and PumpSwap require venue-specific models. |
| USD conversion and fee schedules                     | The deterministic replay supplies these observations. The live collector does not establish suitable contemporaneous conversion and applicable fees.                                       |
| Candle coverage and momentum windows                 | The replay validates a bounded tape and deliberately removes coverage through its gap. The live adapter cannot establish complete strategy windows.                                        |

PumpPortal's documented data API uses one WebSocket for discovery, migration and optional trade subscriptions. Metered collection requires a separate enable flag and an API key. The documented linked-wallet minimum is 0.02 SOL and the published rate is 0.01 SOL per 10,000 streamed events. The local worker counter and provider billing are independent. [Data API](https://pumpportal.fun/data-api/real-time/) and [fees](https://pumpportal.fun/fees/).

## Architecture and files

- `apps/worker/src/forward/forwardTradingService.ts` owns process mode selection, connection ownership and shutdown. `replayProvider.ts` supplies a bounded synthetic stream and `liveProvider.ts` composes the existing scanner, risk service and bounded evidence queue.
- `candidateManager.ts` applies watchlist admission, pool age, current risk and held-position priority. It feeds the existing candle builder. `replayCoordinator.ts` calls the existing signal engine and commits each frame with its cursor and intents. `paperFlow.ts` schedules quotes and landings, then uses the shared paper reducer for risk, positions and accounting.
- `account.ts`, `checkpoint.ts` and `meteredFeed.ts` define account initialization, recoverable runtime state and metered evidence admission. `monitor.ts` and `cli.ts` expose persisted controls, status, positions and performance comparison.
- `packages/database/src/forwardSchema.ts` and migration `0011_forward_paper.sql` add the forward account and append-only runtime event tables. Attempts can reference a forward portfolio or a backtest run. The existing financial ledger remains the source of truth. The Drizzle journal and `0011_snapshot.json` record the schema change.
- Existing database `client.ts`, `paperRepository.ts`, `paperSchema.ts`, `executionSchema.ts` and `schema.ts` support advisory ownership, explicit account mode and separate audit bindings. Shared `paper.ts` adds the forward execution binding and stale feed command. Shared `scanner.ts` adds the budget gap reason.
- Existing worker `config/index.ts` and `index.ts` wire the explicit runtime path. The scanner client, scanner service and event processor expose optional metered subscriptions, gaps and rate limits. Portfolio recovery accepts a preloaded journal, the reducer records feed uncertainty, and the legacy admin CLI routes forward controls to their dedicated commands. The backtest performance analyzer also accepts forward metrics inputs.
- `.env.example`, `package.json` and `README.md` document and expose the new commands. `forwardProvider.test.ts` and `forwardTrading.integration.test.ts` cover the new paths.

## Commands and results

| Command or check                                                             | Actual result                                                                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                             | Passed                                                                                                                                               |
| `pnpm lint`                                                                  | ESLint and Prettier passed                                                                                                                           |
| `pnpm test`                                                                  | 283 tests passed across 27 files                                                                                                                     |
| `pnpm test:integration`                                                      | 52 tests passed across 10 files                                                                                                                      |
| `pnpm build`                                                                 | Passed                                                                                                                                               |
| `pnpm db:migrate`                                                            | Applied migration 0011 on development. The integration suite applied migrations to the dedicated test database.                                      |
| `pnpm db:generate`                                                           | No schema drift                                                                                                                                      |
| `FORWARD_PAPER_ENABLED=true pnpm paper:forward`                              | Completed and recovered the same named replay on a second invocation                                                                                 |
| `pnpm paper:status` and `pnpm paper:positions`                               | Reported the saved account, closed position and trailing high                                                                                        |
| `pnpm paper:performance --backtest-run 70b3364c-3643-80c4-a95c-caa7e03d3ac8` | Reported the forward metrics and the stored Week 7 synthetic baseline side by side                                                                   |
| Local PostgreSQL inspection                                                  | Confirmed four filled attempts, exact balances and fees, one paired outage, one signal, 21 equity snapshots and zero overlapping backtest portfolios |

The first database attempt surfaced a stopped Docker daemon. Starting the local PostgreSQL services resolved the connection failure. The integration tests use PostgreSQL and an offline transport. They verify ownership across independent database connections, pause during an open position, outage and stale equity, restart with a preserved trailing peak, repeat idempotency, explicit halt reset, rollback after an injected write fault, pre-landing cancellation during a gap, and durable metered shutdown. The held-position test verifies priority at capacity and prevents a complete candle from claiming time before watchlist admission.

## Observed replay session

Default account `week8`, portfolio `dac8a1e2-9e01-8324-a692-6513d40079a2`. The coordinator reused the existing strategy version and Week 7 baseline execution settings. All times in this table are synthetic source time in UTC.

| Source time       | Operation                                               | Modeled fees USD |
| ----------------- | ------------------------------------------------------- | ---------------: |
| 00:14:05.000      | One `BUY_CANDIDATE`                                     |                — |
| 00:14:07.000      | Buy filled after the 00:14:06.950 landing threshold     |         0.003495 |
| 00:16:02.010      | First take-profit partial sale                          |       0.00230775 |
| 00:16:10–00:17:15 | Simulated disconnect and reconnect while holding tokens |                — |
| 00:17:17.010      | Second take-profit partial sale                         |       0.00332625 |
| 00:19:02.010      | Trailing stop closed the remainder                      |       0.00274425 |

Example record from the CLI log, with process fields omitted.

```json
{
  "at": "2026-01-01T00:16:02.010Z",
  "outcome": "EXIT_FILLED",
  "reasons": ["TAKE_PROFIT_1", "PARTIAL_POSITION_EXIT"],
  "msg": "Forward paper operation"
}
```

From a $100 virtual bankroll, the final cash and marked equity were **$101.098514**. Realized net P&L was **$1.098514**, fees totaled **$0.01187325**, and reserved cash, remaining quantity and unrealized P&L were zero. The four fills and their audit rows remained unchanged when the worker recovered the completed account. The integration test also stopped while the position was open and verified that recovery retained the two take-profit flags and the previous trailing high before closing the remainder.

The sample has one closed position and is marked `INSUFFICIENT_SAMPLE`. The result describes the fixture path. During the simulated outage, marked equity for the held position was unknown.

## Limits and Week 9 dependencies

The default replay account has a fixed, bounded tape and immutable risk/execution settings. To test another profile, select a separate named replay account. A live account in the current release is a long-running evidence collector. It does not produce live momentum signals or simulated live fills until the normalization and market readiness gates can be satisfied. The remaining inputs include chain-verified timing and ordering, coverage reconciliation after reconnect, pool identity and creation time, independent USD rates, and venue-specific executable depth and fees.

Metered admission is opt-in. The budget latches on exhaustion or an interrupted paid session, and a stopped worker can be rearmed explicitly on a later UTC day. Offline mock tests verify the persisted latch. The provider can bill messages outside the local accounting window. Real venue validation, richer pipeline latency metrics and live sample statistics remain Week 9 work.
