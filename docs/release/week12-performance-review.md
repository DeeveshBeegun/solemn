# Week 12 performance evidence

**Strategy evidence readiness is INSUFFICIENT_EVIDENCE.** The development database had five synthetic backtest datasets, two forward replay accounts, no genuine historical dataset and no genuine forward trading account or live forward trade observation. The 32 PumpPortal token records are discovery evidence. They do not establish executable depth, verified historical coverage, tradable opportunities or a strategy return. Historical and live-forward return, drawdown, hit rate, costs and exposure are unavailable.

The following figures come from stored fixture reports. They establish accounting behavior under the supplied tape.

| Metric                                         | Synthetic analytics backtest | Synthetic forward replay |
| ---------------------------------------------- | ---------------------------: | -----------------------: |
| Coverage on 2026-01-01 UTC                     |                  00:00–02:40 |              00:00–00:20 |
| Starting virtual bankroll                      |                         $100 |                     $100 |
| Ending cash                                    |                  $107.509396 |              $101.098514 |
| Ending marked equity                           |                      Unknown |              $101.098514 |
| Booked period realized P&L                     |        $7.832448582299545949 |                $1.098514 |
| Ending unrealized P&L                          |                      Unknown |                       $0 |
| Net marked return                              |                      Unknown |                1.098514% |
| Booked fees                                    |                 $0.080865444 |              $0.01187325 |
| Peak reliable equity                           |                  $108.597434 |              $101.412769 |
| Maximum observed drawdown, incomplete coverage |                    2.834574% |                0.309877% |
| Unresolved positions / remaining basis         |    1 / $0.323052582299545949 |                   0 / $0 |
| Candidates / entry attempts / entry fills      |                    8 / 8 / 7 |                1 / 1 / 1 |
| Exit attempts / fills / failed exits           |                  18 / 14 / 4 |                3 / 3 / 0 |
| Closes / wins / losses                         |                    6 / 3 / 3 |                1 / 1 / 0 |
| Win rate                                       |                          50% |        100% of one close |
| Average net win / loss                         |       $3.204470 / −$0.860467 |  $1.098514 / unavailable |
| Net expectancy per close                       |        $1.172001333333333333 |                $1.098514 |
| Profit factor                                  |                     3.724105 | Undefined without a loss |
| Average holding seconds                        |                       175.51 |                   295.01 |

The synthetic analytics run reported one gap, 1,121 missing market-minute intervals over the staggered declared universe, 71 uncertain equity snapshots, no unverifiable executions and one unpriced terminal position. The replay recorded a simulated 65-second gap. Pump.fun and PumpSwap models are unsupported. The favorable fixture had six closed positions over one UTC date and one deliberately large winner. That winner accounted for 77.02% of gross winning P&L. Removing it leaves −$0.372274 across the other five closes. Removing all three winners leaves −$2.581401. The no-trade comparison would hold the initial $100 in cash before any operating expense. The synthetic runs provide no credible measure of an advantage over that baseline.

Dependence across real opportunities, date or regime consistency, out-of-sample performance and fee sensitivity in live conditions are unknown. The fixture has no empirical uncertainty interval. For later evaluation, report serial and token clustering and use time-block or clustered resampling only when the independent coverage supports it. Preserve failed, delisted, illiquid and missed markets in the sampling frame to reduce selection bias.

## $100 research economics

At the configured 1% allocation, initial order budget is $1, with up to three open positions and a $0.01 internal minimum. Venue support at this size has not been verified. The Week 7 baseline assumes 1,000 ms latency, a 500 bps quote tolerance and 5,200 lamports per included attempt. The reference CPMM fixture charges 30 bps on input. It uses a hypothetical $150/SOL conversion, which gives $0.00078 in native costs per included attempt. Quote tolerance limits allowed price movement. Actual price impact and adverse movement depend on the pool and observation.

For an illustrative $1 buy and one sell, with 30 bps per side, $0.00078 per included attempt and zero impact or adverse movement, the exit price multiplier needed to recover the $1 is `(1 + 0.00078) / ((1 - 0.00078) × (1 - 0.003)^2)`, or about **0.76% appreciation**. Partial exits, failed attempts, slippage, transfer fees and infrastructure can raise the hurdle. The legacy fixture model instead uses configured 1% buy and sell fees and 1% baseline slippage assumptions. These models are research assumptions. Actual venue minimums, route fees, reliable signal frequency and recurring infrastructure cost are unknown.

PumpPortal lists 0.01 SOL per 10,000 streamed trade events, while discovery and migration subscriptions are free. At the same illustrative SOL conversion, one metered increment would cost $1.50, or 1.5% of the starting bankroll. No paid access was used during release verification. The evidence does not justify paid collection as a trading expense or establish economic feasibility for a $100 account. [PumpPortal fee schedule](https://pumpportal.fun/fees/).

## Forward validation plan

Once executable source evidence can pass the gate, collect an initial four to eight weeks of genuine forward observations and extend as needed. Freeze strategy, paper risk, execution configuration and sources before a prospective validation window. Include missed observations, execution failure, modeled and observed cost differences, and mark uncertainty. Report rejected opportunities, position-level and portfolio-level net results, drawdown, unresolved exposure, fees, data completeness and operating costs against the no-trade baseline. Keep comparable verified historical records separate. Register a new independent period after a strategy or model change. Collection time and trade counts alone cannot establish a reliable edge.
