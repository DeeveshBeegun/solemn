import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson } from '@solemn/shared';
import { csvCell } from '../backtesting/reportGenerator.js';
import type { SavedEvaluation } from './evaluationRepository.js';

const json = (value: unknown) =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
const text = (value: unknown) =>
  value === null || value === undefined
    ? 'UNKNOWN'
    : String(value)
        .replace(/[\r\n]+/g, ' ')
        .replaceAll('|', '\\|');
function csv(rows: object[], fallback: string[]) {
  const header = rows.length ? Object.keys(rows[0]!).sort() : fallback;
  return `${header.map(csvCell).join(',')}\n${rows.map((row) => header.map((k) => csvCell((row as Record<string, unknown>)[k])).join(',') + '\n').join('')}`;
}
function summary(report: SavedEvaluation) {
  const e = report.evaluation;
  const heading = `# Solemn strategy evaluation\n\n- Evaluation ID ${report.id}\n- Report version ${report.reportVersion}\n- Source ${report.source}\n- Strategy ${text(report.strategyId)}\n- Generated ${report.generatedAt}\n- Research status **${report.status}**\n`;
  if (!e)
    return (
      heading +
      `\nThe selected source has no stored portfolio. ${text(report.reason)}\n\n${report.comparison ? `Comparison status **${report.comparison.status}**.\n` : ''}`
    );
  const p = e.portfolio,
    t = e.trading,
    c = e.costs,
    s = e.signalFunnel;
  const metric = (label: string, value: unknown) =>
    `| ${label} | ${text(value)} |`;
  const details = [
    metric('Opening equity USD', p.openingMarkedEquityUsd),
    metric('Ending cash USD', p.endingCashUsd),
    metric('Ending marked equity USD', p.endingMarkedEquityUsd),
    metric('Period realized net P&L USD', p.realizedNetPnlUsd),
    metric('Period marked return %', p.netReturnPercent),
    metric('Maximum observed drawdown %', p.maximumObservedDrawdownPercent),
    metric('Maximum observed drawdown USD', p.maximumObservedDrawdownUsd),
    metric('Completed positions', t.closedPositions),
    metric('Open positions', t.openPositions),
    metric('Blocked exits', t.blockedExits),
    metric('Win rate % of completed positions', t.winRatePercent),
    metric('Mean net P&L per completed position USD', t.expectancyUsd),
    metric('Median position return %', t.medianPositionReturnPercent),
    metric('Profit factor', t.profitFactor.value ?? t.profitFactor.reason),
    metric('Average winning P&L USD', t.averageWinningPnlUsd),
    metric('Average losing P&L USD', t.averageLosingPnlUsd),
    metric('Booked fees USD', c.bookedFeesUsd),
    metric('Network fees USD', c.networkFeesUsd),
    metric(
      'Known failed transaction fees USD',
      c.knownFailedTransactionFeesUsd,
    ),
    metric('Average observed impact bps', c.averageImpactBps),
    metric('Signed quote movement USD', c.quoteMovementUsd),
  ].join('\n');
  const sensitivity = e.statistics.withoutLargestWinner;
  const sensitivityText = sensitivity
    ? `Removing the largest winner changes closed-position net P&L from ${t.closedNetPnlUsd} USD to ${sensitivity.remainingClosedNetPnlUsd} USD across ${sensitivity.remainingPositions} retained positions. Its share of gross winning P&L was ${text(e.statistics.topWinnerShareOfGrossWinsPercent)}%.`
    : 'Largest-winner sensitivity requires a winner and at least one retained closed position.';
  const reasons = e.evidenceReasons.map((r) => `- ${text(r)}`).join('\n');
  const findings = e.findings
    .map(
      (f) =>
        `- ${text(f.hypothesis)} (${f.sample} observations). ${text(f.futureTest)}.`,
    )
    .join('\n');
  const comparison = report.comparison
    ? `\n## Source comparison\n\n**${report.comparison.status}**\n\n${report.comparison.reasons.map((r) => `- ${text(r)}`).join('\n')}\n\nSee the separate source summaries in metrics.json.\n`
    : '';
  return (
    heading +
    `\n- Portfolio ${e.provenance.portfolioId}\n- Strategy version ${text(e.provenance.strategyVersion)}\n- Configuration fingerprint ${e.provenance.configurationHash}\n- Period ${e.provenance.start} through ${e.provenance.end} inclusive\n- Evaluation type ${e.provenance.periodType} (${e.provenance.periodSelection})\n\n## Performance and costs\n\n| Metric | Value |\n|---|---:|\n${details}\n\nFees are counted once. Price impact and quote movement describe execution prices and can overlap. Drawdown covers observed reliable equity points.\n\n## Signal attribution\n\n${s.buyCandidates} candidates produced ${s.riskApprovedOrders} entry orders, ${s.filledEntries} fills, and ${s.closedPositions} closed positions by the cutoff. The CSV preserves failed, rejected, unresolved and unavailable outcomes.\n\n## Evidence and research\n\n${reasons || '- Evidence classification is descriptive.'}\n\n${findings || '- No feature hypothesis reached the fixed reporting rules.'}\n\n${sensitivityText}\n\nFixed segment bands and their sample counts are in segments.csv. The sensitivity analysis removes positions from the closed distribution without resimulating portfolio allocation.\n${comparison}\n## Next steps\n\n${report.status === 'INSUFFICIENT_DATA' ? 'Collect verified observations under a frozen strategy and evaluate a prospective period.' : 'Repeat the frozen analysis over another independent period before changing strategy settings.'}\n`
  );
}

export async function generateAnalyticsReport(
  report: SavedEvaluation,
  output: string,
) {
  const root = resolve(output),
    destination = join(root, report.id),
    e = report.evaluation;
  const files = {
    'summary.md': summary(report),
    'metrics.json': json({
      ...report,
      evaluation: e ? { ...e, rows: rowCounts(e.rows) } : null,
    }),
    'data-quality.json': json(
      e?.quality ?? { status: 'INSUFFICIENT_DATA', critical: [report.reason] },
    ),
    'trades.csv': csv(e?.rows.trades ?? [], ['positionId', 'closedNetPnlUsd']),
    'signals.csv': csv(
      e?.rows.signals.map(({ features, ...row }) => ({
        ...row,
        ...features,
      })) ?? [],
      ['signalId', 'outcome'],
    ),
    'segments.csv': csv(e?.rows.segments ?? [], [
      'dimension',
      'band',
      'positions',
    ]),
    'equity.csv': csv(e?.rows.equity ?? [], ['at', 'equityUsd', 'reason']),
  };
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(join(root, '.evaluation-'));
  try {
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        writeFile(join(stage, name), content, { flag: 'wx' }),
      ),
    );
    try {
      await rename(stage, destination);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        !['EEXIST', 'ENOTEMPTY'].includes(String(error.code))
      )
        throw error;
      for (const [name, content] of Object.entries(files))
        if ((await readFile(join(destination, name), 'utf8')) !== content)
          throw new Error(
            'Existing analytics artifacts differ from immutable evaluation',
            { cause: error },
          );
    }
    return destination;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
function rowCounts(rows: NonNullable<SavedEvaluation['evaluation']>['rows']) {
  return {
    tradeRows: rows.trades.length,
    signalRows: rows.signals.length,
    segmentRows: rows.segments.length,
    equityRows: rows.equity.length,
  };
}
