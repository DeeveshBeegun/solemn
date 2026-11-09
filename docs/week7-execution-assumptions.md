# Week 7 execution research and assumptions

Research checked 8 November 2026. This is a paper simulator. No signing, keys, transaction submission, or Jupiter order execution is implemented.

## Official mechanics verified

- [Solana fees](https://solana.com/docs/core/fees), [fee structure](https://solana.com/docs/core/fees/fee-structure), and [compute budget](https://solana.com/docs/core/fees/compute-budget): separate base and priority fees. Legacy/v0 priority lamports are `ceil(requested CU limit × micro-lamports per CU / 1,000,000)`. The requested limit, not actual consumption, determines this component. Current documentation also describes V1 absolute priority lamports; the simulator validates that V1 cannot carry a legacy CU price. Current 5,000-lamport signature pricing is a research default, never proof of a historical fee schedule. Included execution failures can pay validator fees while program changes roll back.
- [Transactions](https://solana.com/docs/core/transactions) and [confirmation/expiry](https://solana.com/developers/cookbook/transactions/confirmation): actual blockhash expiry depends on chain progress. The simulator's 15-second quote age is an order/quote policy, **not** a conversion of the blockhash window into fixed seconds. Explicit `EXPIRED` network hints represent modeled expiry. Block-height-driven expiry and confirmation finality tracking are deferred.
- [Jupiter Swap API V2](https://developers.jup.ag/docs/swap): `/swap/v2` order/build flows have different routing/execution responsibilities. There is no Jupiter historical execution adapter here. No present-day route is backdated onto a historical trade.
- [Pump.fun bonding curves](https://pump.fun/docs/bonding-curve): virtual reserves, real reserves, completion and migration require their own model. A bonding curve is not supported by substituting ordinary deposited reserves.
- [Pump fees](https://pump.fun/docs/fees), dated 17 October 2026 at review: PumpSwap includes venue-specific fee tiers and quote-asset fee rules. No current tier is presumed historically valid. `REFERENCE_CPMM_V1` is deliberately a defined research pool, **not** an implementation of PumpSwap or Pump.fun.
- [Token-2022 transfer fees](https://solana.com/docs/tokens/extensions/transfer-fees): configured mint fees reduce the recipient's spendable amount, with fees withheld on the destination. Account size/rent can differ with extensions. The reference model accepts an already selected historical transfer schedule, rounds percentage fees upward to integer units and applies the configured maximum. Epoch selection, withheld-fee harvesting and arbitrary transfer hooks are not simulated. Transfer restrictions/freeze are explicit failures.

These references establish mechanisms, not historical reserve balances, fee schedules, latency measurements or failure probabilities.

## Exact supported reference pool contract

Amounts and reserves are integer base units; supported decimal counts are 0–18. Assets must differ. Zero reserves are valid observations of disappeared liquidity, but cannot quote. Negative, fractional or oversized integer strings are invalid. UNKNOWN quality, missing quote/USD conversion, unknown transfer state and unsupported models cannot fill.

For input reserve `x`, output reserve `y`, gross input `a`:

1. Withhold input transfer fee `t = min(ceil(a × transferBps / 10000), maximumUnits)`.
2. Compute each applicable LP, protocol, creator, routing and integrator fee separately as `ceil((a − t) × categoryBps / 10000)` in the **input asset**. This is the reference pool's contract; venues that charge the quote asset on both directions are unsupported.
3. `effective = a − t − sum(venue fees)`; `grossOutput = floor(y × effective / (x + effective))`.
4. Apply any output transfer fee; the recipient gets net output.
5. New input reserve is `x + (a − t) − external venue fees`. LP fees stay in the pool. New output reserve is `y − grossOutput`. The product cannot decrease.

BUY uses exact net token output with minimum required integer input and a maximum-input slippage limit. Integer output rounding surplus stays in the pool. SELL uses exact gross token input and a minimum net-output limit. This preserves the existing Week 5 order convention that `quantity` denotes token quantity on either side. Exact-output input search is bounded. Updated hypothetical reserves and marginal prices are available from the pool model; source observations are never mutated.

Curve impact compares the fee-adjusted input's linear reserve quote with the curve output. Execution cash flows already contain impact and venue/transfer fees. No additional generic slippage or impact percentage is deducted. Quote-to-landing movement is represented by a new source pool observation, not a price penalty.

## Accounting, costs and funding

Pool and token transfer costs are included in the simulated swap cash flow. Their USD estimates use the relevant reserve marginal price and historical quote/USD conversion; that reporting allocation is approximate for token-denominated fees, while actual quote cash and token units remain exact. The adapter splits included fees out of `notionalUsd` so the existing ledger charges them once. Native validator costs are added separately. The legacy policy's 1% fee/slippage assumptions remain only on Week 6 runs.

Included failures post an execution expense: cash and realized P&L decrease, token quantity/cost basis do not change. Failed-entry expenses belong to the portfolio without creating a position. Failed-exit expenses also accrue to the existing position. Local rejection, never-landed drop and modeled expiry have no landed validator costs. Venue fees are charged only on successful swaps. An explicit route tip is conditional on successful execution; it is off by default. No routing, integrator or creator fee is added merely because that category exists.

Native amounts stay in lamports in audits. Conversion requires a source-identified SOL/USD rate available at the simulated time, no older than the configured quote-age bound. The USD bankroll assumes just-in-time SOL funding at that supplied historical rate, without an extra FX spread, subject to `availableLamports` as a **per-attempt** funding cap. It does not maintain a separate speculative SOL inventory. Missing conversion or ambiguous landing halts automated execution and makes net USD metrics/equity incomplete. Known balances and fees remain visible; they are not a claim that unknown liabilities are zero.

Nonzero account rent deposits are explicitly rejected with `RECOVERABLE_RENT_ACCOUNTING_UNSUPPORTED`. Existing token accounts are assumed in the four supplied scenarios. Recoverable rent is never expensed as a permanently lost trading fee. Account creation/recovery accounting is deferred.

The ledger invariant remains `cash + reserved cash + remaining position basis = initial balance + realized P&L`. Network expenses satisfy it even without a fill. Actual trade cash flows, fee components and postings are recorded together transactionally.

## Time, observations, retries and counterfactuals

The Week 6 `SimulationClock` schedules separate processing, quote, preparation, submission and landing stages. Quotes are captured only when their simulated retrieval time arrives; no future observation is used. The next valid execution observation must be observed at/after the due time and available by execution. No real sleeps occur. Actual latency includes waiting for observation availability and can exceed the configured sum. Missing observations cannot manufacture a fill.

BUY sizing leaves 5% headroom and funds the configured maximum-input tolerance inside the existing 1% position allocation. Allocation, cash, risk and quote funding are checked again at settlement. Pending intents do not reserve capital before settlement, matching the existing replay design. This is conservative: a later entry can be rejected after another action changes the available budget.

Deterministic failure draws hash seed + mint/side/trigger time; run UUIDs do not influence the draw. Distributions are research parameters, never claimed measurements. Each retry is a separate order/attempt and can incur a separate included fee. Each position has a bounded retry window. A demonstrated transition from an unavailable to an executable route opens a fresh retry window, allowing exits after liquidity returns. Ambiguous landing never triggers a blind retry; it requires external reconciliation, which is not implemented in this milestone.

A new immutable external pool observation resets the counterfactual reserve anchor. This is an exogenous tape replay, not a full market feedback simulator. Hypothetical post-fill reserves are audited; future historical prices/reserves are not rewritten to reflect our simulated orders. Shared timestamps use the existing ordering/ambiguity rules. Aggregate reported liquidity is never converted into invented reserves.

## Supplied scenarios and fixture validity

All scenarios share the exact dataset fingerprint, strategy, risk policy, eligible universe and $100 bankroll. Seed defaults to 42. Only execution assumptions differ:

| Scenario    | Stage sum | Pool fees                  |  Signature fee | CU price (micro-lamports) | Drop / included-failure / ambiguous assumptions |
| ----------- | --------: | -------------------------- | -------------: | ------------------------: | ----------------------------------------------- |
| idealized   |    300 ms | zeroed for diagnostic      |              0 |                         0 | 0 / 0 / 0                                       |
| baseline    |  1,000 ms | LP 25 bps + protocol 5 bps | 5,000 lamports |                     1,000 | 0 / 0 / 0                                       |
| pessimistic |  3,000 ms | same                       |          5,000 |                   100,000 | 5% / 10% / 0                                    |
| extreme     | 10,000 ms | same                       |          5,000 |                   500,000 | 20% / 20% / 5%                                  |

One signature, 200,000 requested CU, no tip, no account creation, and a 5% quote tolerance are explicit research defaults. The network fee configuration's stated 2020–2030 period is its permitted research range, not evidence that these rates applied throughout that decade. Pool fee schedules are valid only over the synthetic fixture interval. Extreme additionally models a local network outage from 00:15:59 to 00:16:15 UTC on the fixture date, 1 January 2026; it has no effect outside that interval.

The stress tape extends Week 6's strategy/risk observations with separately authored reserve snapshots. It includes a stop quote around $90 followed by a gap to $8 (>90% below entry), zero reserves followed by restored liquidity, and frozen transfers. Displayed strategy-candle prices and pool execution prices are deliberately separate synthetic feeds; execution prices are not inferred from aggregate liquidity. Venue restrictions remain even in idealized mode. Idealized means minimal costs, not guaranteed exits. Week 6 reference ignores these new pool constraints using its original price/percentage model, exposing that model's optimism.

Operational history currently has no verified historical reserve tape. Fixture profits/losses validate mechanics and are **not historical strategy performance**. Real-history requests never substitute synthetic observations.

## Scope and next work

Supported: reference single-pool constant product, exact integer quantities, explicit transfer/venue fees, legacy/v0 and V1 modeled native cost mechanisms, quote age/slippage, deterministic latency/failures, transactional audits, stress comparisons, unresolved exposure.

Unsupported: Pump.fun/PumpSwap pricing, CLMM/DLMM, multi-hop quotes, historical fee-tier/transfer-epoch discovery, token hooks, nonzero rent deposits, real confirmation reconciliation, live routes, empirical congestion calibration, survivorship correction, strategy optimization and market feedback. The registration API allows future models without silently treating them as constant-product pools.

Week 8 should collect timestamped program-specific reserve/depth and fee evidence, implement a verified venue adapter, add historical block-height/confirmation and rent-asset accounting, and validate against observed transaction outcomes. Execution simulation remains an approximation, not a guarantee of equivalent live fills.
