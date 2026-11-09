# Solemn Program Overview

## What Solemn does

Solemn is a **paper-trading research system for newly launched Solana tokens**. It discovers tokens, checks them for risk, looks for a specific momentum pattern, and simulates buying and selling with a virtual bankroll. PostgreSQL stores the decisions, orders, fills, balances, and evidence behind each result.

The current release, **v0.1.0-rc.1**, can run the complete paper-trading cycle on deterministic replay data. It can also collect live discovery data and request live Jupiter quotes. Live market observations cannot currently authorize paper entries because verified execution data for those markets is unavailable. Solemn has no wallet-signing or transaction-broadcasting capability.

## How the workflow fits together

1. **Discover and screen.** The scanner stores token creation and migration events. The risk engine checks each token against the configured policy.
2. **Find a setup.** Given complete market observations in a replay or backtest, the strategy builds one-minute candles and evaluates the momentum pattern.
3. **Check the entry.** A matching pattern produces a `BUY_CANDIDATE`. The portfolio checks risk, cash, market data, and operational controls before creating an order.
4. **Simulate execution.** The paper engine models whether an order fills, what price it receives, and what fees it incurs. It monitors any resulting position for exit conditions.
5. **Record and review.** PostgreSQL stores the financial ledger. Solemn uses it to restore portfolios after a restart and to calculate performance reports.

Live discovery and Jupiter quote research run separately from paper settlement. A discovery event or quote can add research evidence without changing the paper balance.

## 1. Token discovery and risk screening

When enabled, the scanner listens for PumpPortal token creation and migration events. It identifies each token by its **mint address** and deduplicates repeated messages. A migration can update the record with information about where the token trades.

The risk engine combines Jupiter token information with read-only Solana RPC checks. It looks at reported liquidity and holder concentration, whether an authority can mint more tokens or freeze accounts, and whether the token uses features Solemn can interpret.

An assessment can be `ELIGIBLE`, `REJECTED`, or `UNKNOWN`. Eligibility expires. Missing or stale evidence can leave a token `UNKNOWN`. The default policy requires at least **$40,000 in reported aggregate liquidity** and permits up to **35% reported top-holder concentration**. Aggregate liquidity serves as a screening input. The simulator needs separate pool reserves to estimate an executable price.

## 2. Momentum strategy

The strategy, `SOLEMN_LAUNCH_MOMENTUM_V1`, groups market observations into **one-minute candles** that summarize prices and volume. It requires ten consecutive, complete candles. If the feed misses part of a minute, Solemn records the gap and treats that interval’s volume as unavailable.

The default entry pattern has three stages.

1. **Initial spike.** A candle closes more than 5% above the highs of the previous three candles. Solemn records the spike candle’s high as resistance.
2. **Pullback.** A separate candle shows a pullback of at least 10%.
3. **Breakout.** A later candle closes more than 1% above the recorded resistance. The activity filters must also pass, including positive one- and five-minute momentum, at least double the preceding five-minute volume, a buy-to-sell volume ratio of at least 1.5, and at least 40 identifiable buyers in the recent five-minute window.

A match produces a `BUY_CANDIDATE`. The portfolio can still block the entry because of stale risk evidence, a feed gap, a missing executable quote, insufficient cash, an existing position in the token, or a pause or halt.

## 3. Paper orders and position management

A new paper account starts with **$100 in virtual cash** by default. The maximum allocation per entry is **1% of current marked equity**, capped by available cash. That gives the first entry an initial budget of up to **$1**. The default account permits up to three concurrent positions.

In forward replay, the simulator takes a quote from the fixture and waits through modeled processing and execution delays. It then uses the pool observation available at the simulated execution time to calculate price impact, fees, and whether the order can fill within its slippage limit. A failed attempt can incur a modeled network fee without opening a position. A successful buy records the quantity received and its cost basis, which is the amount invested in those tokens.

The default exit rules include the following.

- **Stop-loss at −25%.** Attempt to sell the remaining position.
- **First take-profit at +60%.** Attempt to sell about one-third of the original quantity.
- **Second take-profit at +150%.** After the first target completes, attempt to sell half of the remaining quantity.
- **Trailing stop after the second target.** Attempt to sell the rest if the price falls 30% from its tracked high.
- **Maximum holding time of 60 minutes.** Attempt an exit when the position reaches its time limit.

If liquidity disappears or reliable pricing is unavailable, an exit can stay blocked. Solemn keeps the remaining quantity and cost basis on the ledger and can report the position’s current value as unknown.

## 4. Accounting, restart recovery, and controls

The paper ledger records cash movements, reserved funds, simulated fills, fees, and changes to positions. A partial sale realizes profit or loss on the quantity sold while leaving the rest open. Cash and marked equity can therefore differ. Ending equity can be unknown when an open holding has no reliable mark.

A forward worker holds a PostgreSQL ownership lock so two workers cannot write to the same portfolio at once. On restart, Solemn checks the journal against stored balances and fills, then restores the replay cursor, open holdings, and exit state.

`PAUSED` and `HALTED` block new entries while eligible protective exits can still proceed. A halt persists across restarts. Clearing it requires an explicit reset with verified ownership, fresh health checks, and ledger reconciliation.

## 5. Analytics and what the results mean

The analytics reports separate **realized profit and loss** from the estimated value of open holdings. They show fees, win rate, drawdown, average net profit or loss per closed position, and how many candidates became filled or closed positions. Reports also show market-data gaps and whether a result depended heavily on a single winner.

The standard **synthetic forward replay** starts with $100, opens one position, executes two partial take-profits, and sells the remainder on a trailing stop. It records a simulated 65-second feed gap and finishes with **$101.098514 in virtual cash**. This result shows the expected behavior on a known input. The release audit found five synthetic backtest datasets and two forward replay accounts, with no genuine historical or forward trading sample from which to estimate a trading edge.

## Main commands

- `pnpm start` starts the compiled worker. Configuration determines which services it enables. The release example starts with optional services disabled.
- `FORWARD_PAPER_ENABLED=true pnpm paper:forward` runs the default synthetic tape through the forward worker. Reusing the account name resumes its saved cursor.
- `pnpm backtest --dataset fixtures-analytics` runs a separate synthetic backtest with wins, losses, a failed entry, and a blocked exit.
- `pnpm paper:positions` shows the selected forward portfolio’s positions, quantities, cost basis, and exit state.
- `pnpm solemn:health` shows the selected forward account’s state, ownership, feed health, and active incidents.
- `pnpm analytics:report` generates a report for the selected source and portfolio. Use `--source synthetic --portfolio UUID` to select a synthetic backtest portfolio.
- `pnpm swap:quote` requests an opt-in Jupiter quote for the supplied pair and amount. It records a separate assessment without changing the paper portfolio.
