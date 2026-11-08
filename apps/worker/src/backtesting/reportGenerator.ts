import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { BacktestRepository } from '@solemn/database';
import type { BacktestResult } from '@solemn/shared';
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text))
    text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function csv(
  path: string,
  headers: string[],
  rows: AsyncIterable<unknown[]>,
) {
  const file = await open(path, 'w');
  try {
    await file.write(headers.map(csvCell).join(',') + '\n');
    for await (const row of rows)
      await file.write(row.map(csvCell).join(',') + '\n');
  } finally {
    await file.close();
  }
}
function flatten(value: unknown, prefix = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value).flatMap(([key, entry]) =>
      flatten(entry, prefix ? `${prefix}.${key}` : key),
    );
  return [[prefix, value]];
}
const display = (value: unknown) =>
  value === null || value === undefined ? 'unavailable' : String(value);
export async function generateBacktestReport(
  result: BacktestResult,
  repository: BacktestRepository,
  outputDirectory: string,
) {
  const directory = resolve(outputDirectory, result.plan.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  await writeFile(
    join(directory, 'data-quality.json'),
    JSON.stringify(
      { dataset: result.dataset.quality, selectedRange: result.runDataQuality },
      null,
      2,
    ) + '\n',
  );
  const { metrics, plan } = result;
  async function* summaryRows() {
    for (const row of flatten(metrics)) yield row;
  }
  await csv(join(directory, 'metrics.csv'), ['metric', 'value'], summaryRows());
  async function* equityRows() {
    for await (const point of repository.equitySeries(
      plan.runId,
      plan.batchSize,
    ))
      yield [
        point.timestamp,
        point.availableCashUsd,
        point.reservedCashUsd,
        point.markedPositionsUsd,
        point.totalEquityUsd,
        point.realizedPnlUsd,
        point.unrealizedPnlUsd,
        point.drawdownPercent,
        point.valuationQuality,
        point.reasons.join('|'),
      ];
  }
  await csv(
    join(directory, 'equity.csv'),
    [
      'timestamp',
      'available_cash_usd',
      'reserved_cash_usd',
      'marked_positions_usd',
      'total_equity_usd',
      'realized_pnl_usd',
      'unrealized_pnl_usd',
      'drawdown_percent',
      'valuation_quality',
      'reasons',
    ],
    equityRows(),
  );
  async function* orderRows() {
    for await (const event of repository.ledger(
      plan.portfolioId,
      plan.batchSize,
    ))
      for (const record of event.orders) {
        const fill = record.trades[0],
          position = result.finalState.positions.find(
            (item) => item.id === record.positionId,
          ),
          realized =
            event.postings.find((posting) => posting.type === 'SELL_FILL')
              ?.realizedDeltaUsd ?? null;
        yield [
          record.order.id,
          record.positionId,
          record.order.tokenMint,
          record.order.side,
          record.order.status,
          record.order.createdAt,
          position?.openedAt ?? null,
          record.order.side === 'SELL' && fill ? fill.timestamp : null,
          record.order.requestedQuantity,
          fill?.executedQuantity ?? null,
          fill?.executionPriceUsd ?? null,
          fill ? record.notionalUsd : null,
          fill?.feesUsd ?? null,
          fill ? record.slippageUsd : null,
          realized,
          position && fill && record.order.side === 'SELL'
            ? (Date.parse(fill.timestamp) - Date.parse(position.openedAt)) /
              1000
            : null,
          record.reason,
          record.failureReason,
        ];
      }
  }
  await csv(
    join(directory, 'orders-and-fills.csv'),
    [
      'order_id',
      'position_id',
      'mint',
      'side',
      'status',
      'order_timestamp',
      'entry_timestamp',
      'exit_timestamp',
      'requested_quantity',
      'filled_quantity',
      'fill_price_usd',
      'notional_usd',
      'fees_usd',
      'slippage_usd',
      'realized_net_pnl_usd',
      'holding_seconds',
      'reason',
      'failure_reason',
    ],
    orderRows(),
  );
  async function* positionRows() {
    for (const position of result.finalState.positions)
      yield [
        position.id,
        position.mint,
        position.status,
        position.openedAt,
        position.closedAt,
        position.entryPriceUsd,
        position.originalQuantity,
        position.quantity,
        position.initialCostBasisUsd,
        position.costBasisUsd,
        position.realizedPnlUsd,
        position.valuationStale || position.liquidationUncertain
          ? null
          : position.unrealizedPnlUsd,
        position.feesUsd,
        position.valuationStale,
        position.liquidationUncertain,
        position.pendingExitReason,
        position.blockedReason,
      ];
  }
  await csv(
    join(directory, 'positions.csv'),
    [
      'position_id',
      'mint',
      'status',
      'entry_timestamp',
      'closed_timestamp',
      'entry_price_usd',
      'original_quantity',
      'remaining_quantity',
      'initial_cost_basis_usd',
      'remaining_cost_basis_usd',
      'realized_net_pnl_usd',
      'unrealized_pnl_usd',
      'fees_usd',
      'valuation_stale',
      'liquidation_uncertain',
      'pending_exit_reason',
      'blocked_reason',
    ],
    positionRows(),
  );
  async function* intentRows() {
    for await (const intent of repository.intents(plan.runId, plan.batchSize))
      yield [
        intent.id,
        intent.kind,
        intent.mint,
        intent.signalId,
        intent.positionId,
        intent.triggerAt,
        intent.dueAt,
        intent.expiresAt,
        intent.attemptedAt,
        intent.status,
        intent.orderId,
        intent.observationId,
        intent.reason,
        intent.reasons.join('|'),
      ];
  }
  await csv(
    join(directory, 'execution-intents.csv'),
    [
      'intent_id',
      'kind',
      'mint',
      'signal_id',
      'position_id',
      'trigger_at',
      'due_at',
      'expires_at',
      'attempted_at',
      'status',
      'order_id',
      'observation_id',
      'trigger_reason',
      'result_reasons',
    ],
    intentRows(),
  );
  const md = `# Solemn backtest ${plan.runId}\n\n**Source: ${plan.sourceKind}. Mode: PAPER.** ${plan.sourceKind === 'SYNTHETIC' ? 'This is a synthetic fixture demonstration, not actual historical trading performance.' : 'Historical observations are supplied by the selected dataset; their provenance is declared rather than independently verified.'}\n\n## Run\n\n- Dataset: ${result.dataset.manifest.datasetId} / ${result.dataset.manifest.version}\n- Dataset fingerprint: ${plan.datasetFingerprint}\n- Strategy: ${plan.strategy.strategyId} / ${plan.strategy.version}\n- Historical range: ${plan.startTime} to ${plan.endTime}\n- Portfolio: ${plan.portfolioId}\n- Starting balance: ${plan.paper.initialBalanceUsd} USD\n- Execution delay: ${plan.executionLatencyMs} ms; next eligible observation required; wait limit ${plan.executionWaitMs} ms\n- Buy/sell fees: ${plan.paper.buyFeePercent}% / ${plan.paper.sellFeePercent}%; baseline adverse slippage: ${plan.paper.slippagePercent}%\n\n## Performance\n\n| Metric | Strategy | No-trade baseline |\n|---|---:|---:|\n| Ending cash USD | ${metrics.portfolio.endingCashUsd} | ${metrics.baseline.endingEquityUsd} |\n| Ending reliable marked equity USD | ${display(metrics.portfolio.endingMarkedEquityUsd)} | ${metrics.baseline.endingEquityUsd} |\n| Realized net P&L USD | ${metrics.portfolio.realizedNetPnlUsd} | 0 |\n| Unrealized P&L USD | ${display(metrics.portfolio.unrealizedPnlUsd)} | 0 |\n| Net return % | ${display(metrics.portfolio.totalNetReturnPercent)} | 0 |\n| Maximum observed reliable drawdown % | ${metrics.portfolio.maximumDrawdownPercent} | 0 |\n| Fees USD | ${metrics.portfolio.totalFeesUsd} | 0 |\n| Modeled slippage USD | ${metrics.portfolio.simulatedSlippageUsd} | 0 |\n| Closed positions | ${metrics.trading.closedPositions} | 0 |\n| Closed-position win rate % | ${display(metrics.trading.winRatePercent)} | unavailable |\n| Average win / loss USD | ${display(metrics.trading.averageWinningPnlUsd)} / ${display(metrics.trading.averageLosingPnlUsd)} | unavailable |\n| Expectancy per closed position USD | ${display(metrics.trading.expectancyUsd)} | unavailable |\n| Profit factor | ${display(metrics.trading.profitFactor.value)}${metrics.trading.profitFactor.reason ? ` (${metrics.trading.profitFactor.reason})` : ''} | unavailable |\n| Remaining open positions | ${metrics.strategy.positionsRemainingOpen} | 0 |\n\nDrawdown coverage complete: **${metrics.portfolio.drawdownCoverageComplete}**. Uncertain equity snapshots: **${metrics.dataQuality.uncertainEquitySnapshots}**. Unpriced/uncertain open positions: **${metrics.dataQuality.unpricedOpenPositions}**. Missing equity is unavailable, never a zero-risk or zero-loss assumption.\n\n## Evidence and configuration\n\n- [Exact configuration, metrics and final state](result.json)\n- [Dataset quality](data-quality.json)\n- [Equity curve](equity.csv)\n- [Orders and individual fills, including partial position exits](orders-and-fills.csv)\n- [Positions and unresolved exposure](positions.csv)\n- [Scheduled, failed and unfilled execution intents](execution-intents.csv)\n- [All metrics](metrics.csv)\n\n## Limitations\n\n${result.limitations.map((item) => `- ${item}`).join('\n')}\n- Display ratios and percentage statistics truncate at 18 decimal places; monetary accounting retains the Week 5 conservative rounding policy.\n- Open positions are excluded from closed-position wins, losses and profit factor.\n- Empty equity CSV cells denote unavailable valuation.\n- A profitable backtest does not guarantee profitable live trading. No statistical significance, annualized return or Sharpe-ratio claim is made.\n`;
  await writeFile(join(directory, 'report.md'), md);
  return directory;
}
