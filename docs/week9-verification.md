# Week 9 verification

Solemn evaluated its existing paper ledgers without changing the trading strategy, risk thresholds or execution model. The development database contained four synthetic backtest datasets before Week 9, with 6,661 dataset events, 32 raw discovery or migration events and 76 historical risk-assessment rows. It contained a forward replay with four fills, no verified historical dataset and no genuine forward portfolio. Scanner and risk records alone did not provide the transaction order, coverage and executable pool state needed for an empirical comparison.

## Synthetic backtest

The new fixture uses eight independent synthetic markets over 160 minutes on 2026-01-01 UTC. It ran with a $100 virtual bankroll and the Week 7 baseline execution preset. The backtest run was `a8ebed1c-bd3b-8a05-a760-bfa10554eb6c`, using dataset `72207f1f-1dd8-8a57-a1f2-6883ec3eba24` and portfolio `b7fbb12c-a5ed-8e63-a1c9-96892afe8ee7`.

| Metric                                               |          Observed synthetic result |
| ---------------------------------------------------- | ---------------------------------: |
| Buy candidates / entry orders / entries filled       |                          8 / 8 / 7 |
| Completed positions / blocked exits / failed entries |                          6 / 1 / 1 |
| Wins / losses / break-evens                          |                          3 / 3 / 0 |
| Win rate                                             |                                50% |
| Completed-position net P&L                           |                          $7.032008 |
| Expectancy per completed position                    |              $1.172001333333333333 |
| Average net win / average net loss                   | $3.204469666666666666 / −$0.860467 |
| Profit factor                                        |               3.724105243625457648 |
| Ending cash                                          |                        $107.509396 |
| Booked period realized P&L                           |              $7.832448582299545949 |
| Ending marked equity / net portfolio return          |                  Unknown / unknown |
| Maximum observed drawdown                            |  $2.906199 / 2.834574019909753577% |
| Booked fees, including failed transactions           |                       $0.080865444 |
| Known fees on failed transactions                    |                           $0.00312 |
| Longest completed-position losing streak             |                                  3 |

The eight signal outcomes were three closed wins, three closed losses, one failed entry and one blocked exit. The blocked position had a realized partial exit, which contributes to the ledger's period realized P&L. The ledger also books the failed entry's $0.00078 charge. The blocked position retains $0.323052582299545949 of cost basis with uncertain terminal valuation. Drawdown uses the available reliable equity marks and has incomplete coverage.

The largest winner earned $7.404282, or 77.02% of gross winning P&L. Removing it leaves −$0.372274 over five positions. Removing the three winners leaves −$2.581401 over three positions. These calculations change the distribution of recorded outcomes only. The first half of the evaluation had four closes totaling $0.480886. The second half had two closes totaling $6.551122. All six closes occurred on one UTC date.

### Segment and quality observations

The report produced 26 segment rows. All six closes and the blocked exit share the same venue, pool-age band of 5 to under 15 minutes, and liquidity band of $50,000 to under $250,000. Those entry features have no cross-band comparison in this fixture.

The three positions held under 60 seconds lost a combined $2.581401. The three completed positions held 60 to under 300 seconds gained $9.613409. The only completed position in the $0.02 to under $0.05 execution-cost band was the largest winner. Five closes in the $0.005 to under $0.02 cost band netted −$0.372274 and that band also included the blocked exit. Holding time and realized execution cost are post-entry measurements. These counts support fixture diagnostics and further data collection.

The stored run audit recorded 7,932 events, 1,908 normalized trades, 5,696 execution observations, one declared market gap and 1,121 missing market-minute intervals across the full declared universe. The markets were staggered in 20-minute blocks. There were no missing scheduled equity snapshots. The report still flagged 71 uncertain equity snapshots and one unpriced position. Execution audits identified fees for the simulated orders. Price impact averaged 0.481110304967624361 bps and remained separate from booked fees.

## Forward and comparison evidence

The stored forward replay used portfolio `dac8a1e2-9e01-8324-a692-6513d40079a2`. One position closed after four fills, with $1.098514 in net P&L, a 1.098514% return on the $100 virtual bankroll and $0.01187325 in booked fees. The runtime recorded a 65-second simulated outage. Profit factor was undefined because there were no losing positions. The historical fixture and the forward replay were **NON_COMPARABLE** under the empirical comparison gate. The genuine-forward selection returned **INSUFFICIENT_DATA** with `NO_STORED_PORTFOLIO_FOR_SELECTED_SOURCE`.

The overall strategy assessment is **INSUFFICIENT_DATA**. The fixture uses constructed prices and an intentionally large winner. Confidence intervals and bootstrap were deferred. Provider latency and comparable market regimes remain unknown. Segment-level drawdown needs segment-level equity series. The stored backtest audit describes the full source run, including when a report selects a shorter slice. The current reader rejects inputs above its 100,000-record per-stream limit. External inspection of stored observations still requires operational holdout discipline.

## Implementation and storage

- `apps/worker/src/analytics/` adds reconciled source selection, portfolio and closed-position calculations, drawdown, execution costs, signal attribution, fixed bands, descriptive validation, source comparison, evaluation persistence, reporting and CLI commands.
- `apps/worker/src/backtesting/analyticsFixture.ts` and the backtest CLI add the synthetic dataset. The backtest performance analyzer reuses the extracted closed-position metrics.
- `packages/database/src/paperRepository.ts` adds bounded read-only ledger snapshots. Migration `0012_strategy_evaluation.sql`, its Drizzle metadata and `analyticsSchema.ts` add immutable evaluations and prospective period registrations. The evaluation record stores report metadata, input and configuration fingerprints, the complete metric payload and the research findings together.
- `apps/worker/tests/analytics.test.ts` and `apps/worker/tests/analytics.integration.test.ts` cover arithmetic, quality gates, cutoff attribution, source isolation, frozen periods and report reproducibility.
- `package.json` adds six analytics commands. `.gitignore` excludes generated reports. `README.md` documents operation and interpretation.

## Checks and artifacts

| Check                   | Actual result               |
| ----------------------- | --------------------------- |
| `pnpm typecheck`        | Passed                      |
| `pnpm lint`             | Passed                      |
| `pnpm test`             | 296 passed across 28 files  |
| `pnpm test:integration` | 54 passed across 11 files   |
| `pnpm build`            | Passed                      |
| `pnpm db:migrate`       | Applied locally             |
| `pnpm db:generate`      | No remaining schema changes |
| `git diff --check`      | Passed                      |

The end-to-end integration test reconciled fees and partial fills to the stored ledger, checked the early cutoff, proved portfolio and backtest records unchanged, and compared repeat report files byte for byte. A separate repeat of the development CLI produced the same evaluation ID and SHA-256 checksums for all seven synthetic report files.

| Source                                  | Report directory under `reports/analytics` | Trade / signal / segment / equity rows |
| --------------------------------------- | ------------------------------------------ | -------------------------------------: |
| Synthetic fixture and replay comparison | `5511045d-8186-8b0a-a2e8-bf9838a80776`     |                     7 / 8 / 26 / 1,582 |
| Forward replay                          | `d3b256aa-6155-86f2-ac63-33790b8a0199`     |                       1 / 1 / 17 / 254 |
| Genuine-forward availability check      | `74d23abc-5723-81da-ac49-2183f1538879`     |                          0 / 0 / 0 / 0 |

Each directory contains `summary.md`, `metrics.json`, `data-quality.json`, `trades.csv`, `signals.csv`, `segments.csv` and `equity.csv`. The reports were inspected after generation.

## Week 10 readiness

The evaluator can accept a prospectively registered window once a genuine forward portfolio and the required market evidence exist. Historical and forward research still needs verified transaction coverage and ordering, pool identity and creation time, contemporaneous USD conversion, and venue-specific depth and fee evidence. Those prerequisites determine whether an empirical comparison can be made.
