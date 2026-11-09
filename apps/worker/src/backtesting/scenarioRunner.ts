import { percentage } from '../portfolio/decimal.js';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stableHash, stableId } from '@solemn/shared';
import type { BacktestOptions, BacktestResult } from '@solemn/shared';
import type { Config } from '../config/index.js';
import type { Logger } from 'pino';
import { executionScenario } from '../execution/simulation/executionScenarios.js';
import type { scenarioNames } from '../execution/simulation/executionScenarios.js';
import { createBacktestPlan } from './backtestConfig.js';
import { runBacktest } from './replayEngine.js';
import type { BacktestServices } from './replayEngine.js';
import type { HistoricalDataProvider } from './historicalDataProvider.js';
import { csvCell, generateBacktestReport } from './reportGenerator.js';
export type ScenarioName = (typeof scenarioNames)[number] | 'week6-reference';
export async function runScenarios(
  provider: HistoricalDataProvider,
  config: Config,
  services: BacktestServices,
  options: BacktestOptions,
  names: ScenarioName[],
  seed: number,
  logger?: Logger,
) {
  const results: BacktestResult[] = [];
  for (const name of names) {
    const execution =
      name === 'week6-reference' ? undefined : executionScenario(name, seed);
    const plan = createBacktestPlan(
      { ...options, ...(execution ? { execution } : {}) },
      provider.dataset,
      config,
    );
    const result = await runBacktest(plan, provider, config, services, logger);
    results.push(result);
    logger?.info(
      { runId: plan.runId, scenario: name, metrics: result.metrics.execution },
      'Execution scenario completed',
    );
  }
  return results;
}
export async function generateScenarioReport(
  results: BacktestResult[],
  services: BacktestServices,
  output: string,
  seed: number,
) {
  if (!results.length) throw new Error('No scenarios selected');
  const comparable = (r: BacktestResult) => ({
    dataset: r.plan.datasetFingerprint,
    strategy: r.plan.strategy,
    risk: r.plan.risk,
    paper: r.plan.paper,
    start: r.plan.startTime,
    end: r.plan.endTime,
  });
  if (
    results.some(
      (r) => stableHash(comparable(r)) !== stableHash(comparable(results[0]!)),
    )
  )
    throw new Error('Scenario comparison inputs differ');
  const experimentId = stableId([
      'execution-experiment-v1',
      seed,
      results.map((r) => r.plan),
    ]),
    directory = resolve(output, `stress-${experimentId}`);
  await mkdir(directory, { recursive: true });
  for (const result of results) {
    const runDirectory = await generateBacktestReport(
      result,
      services.backtests,
      directory,
    );
    const file = await open(join(runDirectory, 'execution-costs.csv'), 'w');
    const auditFile = await open(
      join(runDirectory, 'execution-audit.jsonl'),
      'w',
    );
    try {
      await file.write(
        'attempt_id,order_id,side,outcome,reason,quote_at,executed_at,latency_ms,impact_bps,known_fees_usd,failed_network_fee_usd,unknown_fee_lamports,quote_pool,landing_pool,updated_pool,fee_components\n',
      );
      for await (const event of services.backtests.ledger(
        result.plan.portfolioId,
        1000,
      ))
        for (const record of event.orders) {
          const a = record.audit;
          if (!a) continue;
          await auditFile.write(
            JSON.stringify({
              audit: a,
              order: record.order,
              request: record.request,
              signalId: a.signalId,
              positionId: record.positionId,
              postings: event.postings,
              result: event.result,
            }) + '\n',
          );
          await file.write(
            [
              a.id,
              a.orderId,
              record.order.side,
              a.outcome,
              a.reason,
              a.context.quote.at,
              a.executedAt,
              a.latencyMs,
              a.impactBps,
              a.feeUsd,
              a.outcome === 'FAILED_ON_CHAIN' ? a.networkFeeUsd : '0',
              a.unpricedFeeLamports,
              a.context.quote.pool?.id,
              a.context.pool?.id,
              a.updatedPool ? JSON.stringify(a.updatedPool) : null,
              JSON.stringify(a.fees),
            ]
              .map((v) => csvCell(v === undefined ? null : v))
              .join(',') + '\n',
          );
        }
    } finally {
      await file.close();
      await auditFile.close();
    }
  }
  const rows = results.map((r) => ({
    scenario: r.plan.execution?.scenario ?? 'week6-reference',
    runId: r.plan.runId,
    realizedNetPnlUsd: r.metrics.execution
      ? r.metrics.execution.netRealizedPnlUsd
      : r.metrics.portfolio.realizedNetPnlUsd,
    endingEquityUsd: r.metrics.portfolio.endingMarkedEquityUsd,
    netReturnPercent: r.metrics.portfolio.totalNetReturnPercent,
    knownFeesUsd:
      r.metrics.execution?.knownFeesUsd ?? r.metrics.portfolio.totalFeesUsd,
    fillRatePercent:
      r.metrics.execution?.fillRatePercent ??
      (r.metrics.trading.filledOrders + r.metrics.trading.failedOrders
        ? percentage(
            BigInt(r.metrics.trading.filledOrders),
            BigInt(
              r.metrics.trading.filledOrders + r.metrics.trading.failedOrders,
            ),
          )
        : null),
    filled: r.metrics.trading.filledOrders,
    failed: r.metrics.trading.failedOrders,
    maximumDrawdownPercent: r.metrics.portfolio.drawdownCoverageComplete
      ? r.metrics.portfolio.maximumDrawdownPercent
      : null,
    failedExits: r.metrics.strategy.failedExitAttempts,
    unresolved: r.finalState.positions.filter((p) => p.status !== 'CLOSED')
      .length,
    unknownFeeLamports: r.metrics.execution?.unknownFeeLamports ?? '0',
    execution: r.metrics.execution ?? null,
  }));
  await writeFile(
    join(directory, 'comparison.json'),
    JSON.stringify(
      {
        experimentId,
        seed,
        sourceKind: results[0]!.plan.sourceKind,
        datasetFingerprint: results[0]!.plan.datasetFingerprint,
        assumptions:
          'Synthetic research simulation, not historical profitability. UNKNOWN equity and drawdown are not zero. Rates use attempted orders as denominators. Native funding assumes just-in-time USD/SOL conversion at the supplied historical rate, capped per attempt. External pool tape resets hypothetical reserves.',
        scenarios: rows,
      },
      null,
      2,
    ) + '\n',
  );
  const keys = Object.keys(rows[0]!).filter((k) => k !== 'execution');
  await writeFile(
    join(directory, 'comparison.csv'),
    keys.join(',') +
      '\n' +
      rows
        .map((row) =>
          keys
            .map((k) =>
              csvCell(row[k as keyof typeof row] as string | number | null),
            )
            .join(','),
        )
        .join('\n') +
      '\n',
  );
  await writeFile(
    join(directory, 'comparison.md'),
    `# Week 7 execution stress comparison\n\nSource: ${results[0]!.plan.sourceKind}. Seed: ${seed}. Same dataset, strategy, risk rules and bankroll in every run. Synthetic profits are not evidence of historical strategy profitability.\n\n| Scenario | Known realized P&L USD | Ending equity USD | Fees USD | Fill rate % | Filled / failed | Failed exits | Unresolved | Max drawdown % |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
      rows
        .map(
          (r) =>
            `| ${r.scenario} | ${r.realizedNetPnlUsd ?? 'UNKNOWN'} | ${r.endingEquityUsd ?? 'UNKNOWN'} | ${r.knownFeesUsd} | ${r.fillRatePercent ?? 'N/A'} | ${r.filled} / ${r.failed} | ${r.failedExits} | ${r.unresolved} | ${r.maximumDrawdownPercent ?? 'UNKNOWN'} |`,
        )
        .join('\n') +
      '\n\nOpen, blocked or stale exposure makes total return incomplete. Known realized P&L excludes unresolved exposure; unpriced native costs make net USD P&L UNKNOWN. Idealized is a minimal-cost diagnostic, still subject to the same market and transfer restrictions. See each run’s execution-costs.csv, execution-audit.jsonl and result.json for audit inputs and cost components.\n',
  );
  return { experimentId, directory, rows };
}
