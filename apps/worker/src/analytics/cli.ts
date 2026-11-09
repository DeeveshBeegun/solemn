import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { createDatabase } from '@solemn/database';
import { idSchema, stableHash, timestampSchema } from '@solemn/shared';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { createLogger, safeError } from '../services/logger.js';
import { periodKinds, sources } from './contracts.js';
import type { Selection } from './contracts.js';
import { readEvaluation } from './readEvaluation.js';
import { evaluateStrategy } from './strategyEvaluator.js';
import { compareEvaluations } from './performanceComparison.js';
import { registerPeriod, saveEvaluation } from './evaluationRepository.js';
import type { EvaluationBody } from './evaluationRepository.js';
import { generateAnalyticsReport } from './reportGenerator.js';

const strategyId = 'SOLEMN_LAUNCH_MOMENTUM_V1';
const date = (input: string) =>
  new Date(
    timestampSchema.parse(
      /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00.000Z` : input,
    ),
  ).toISOString();
export function parseAnalyticsArguments(args: string[]) {
  const [action, ...flags] = args;
  const { values } = parseArgs({
    args: flags,
    options: {
      portfolio: { type: 'string' },
      strategy: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      source: { type: 'string' },
      type: { type: 'string' },
      output: { type: 'string' },
      period: { type: 'string' },
      against: { type: 'string' },
      'against-source': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return null;
  const command = z
    .enum(['summary', 'trades', 'signals', 'compare', 'report', 'register'])
    .parse(action);
  const selection: Selection = {
    strategyId: z.literal(strategyId).parse(values.strategy ?? strategyId),
  };
  if (values.portfolio !== undefined)
    selection.portfolioId = idSchema.parse(values.portfolio);
  if (values.source !== undefined)
    selection.source = z.enum(sources).parse(values.source);
  if (values.period !== undefined)
    selection.periodId = idSchema.parse(values.period);
  if (!selection.portfolioId && !selection.source && !selection.periodId)
    selection.source = 'forward';
  if (values.type !== undefined)
    selection.type = z.enum(periodKinds).parse(values.type.toUpperCase());
  if (values.start !== undefined) selection.start = date(values.start);
  if (values.end !== undefined) selection.end = date(values.end);
  if (selection.start && selection.end && selection.start >= selection.end)
    throw new Error('Evaluation start must precede end');
  if (
    selection.type === 'HOLDOUT' &&
    !selection.periodId &&
    command !== 'register'
  )
    throw new Error('Holdout requires prospective registration');
  if (values.against !== undefined && values['against-source'] !== undefined)
    throw new Error('Select one reference portfolio or source');
  if (
    (values.against !== undefined || values['against-source'] !== undefined) &&
    command !== 'report' &&
    command !== 'compare'
  )
    throw new Error('Reference selection requires compare or report');
  const reference: Selection | null =
    values.against !== undefined
      ? {
          strategyId: selection.strategyId,
          portfolioId: idSchema.parse(values.against),
        }
      : values['against-source'] !== undefined
        ? {
            strategyId: selection.strategyId,
            source: z.enum(sources).parse(values['against-source']),
          }
        : null;
  return {
    command,
    selection,
    reference,
    output: z
      .string()
      .min(1)
      .max(4096)
      .parse(values.output ?? 'reports/analytics'),
  };
}
async function main() {
  const args = parseAnalyticsArguments(process.argv.slice(2));
  if (!args) {
    process.stdout.write(
      'pnpm analytics:report --source synthetic|historical|forward-replay|forward|paper-replay [--portfolio UUID] [--start ISO --end ISO] [--type development|validation|holdout|forward] [--period UUID] [--against UUID] [--output PATH]\n',
    );
    return;
  }
  const config = loadConfig(),
    db = createDatabase(config.DATABASE_URL),
    logger = createLogger(config.LOG_LEVEL);
  try {
    if (args.command === 'register') {
      process.stdout.write(
        JSON.stringify(await registerPeriod(db.db, args.selection), null, 2) +
          '\n',
      );
      return;
    }
    logger.info(
      {
        source: args.selection.source,
        portfolioId: args.selection.portfolioId,
        strategy: args.selection.strategyId,
      },
      'Analytics evaluation started',
    );
    const input = await readEvaluation(db.db, args.selection),
      e = input ? evaluateStrategy(input) : null;
    const reference =
      args.reference ??
      (args.command === 'compare'
        ? {
            strategyId: args.selection.strategyId,
            source:
              (input?.source ?? args.selection.source) === 'forward'
                ? ('historical' as const)
                : ('forward' as const),
          }
        : null);
    const other = reference ? await readEvaluation(db.db, reference) : null;
    const comparison = reference
      ? compareEvaluations(e, other ? evaluateStrategy(other) : null)
      : null;
    const body: EvaluationBody = {
      source: input?.source ?? args.selection.source ?? 'forward',
      strategyId: args.selection.strategyId,
      requestedStart: input?.start ?? args.selection.start ?? null,
      requestedEnd: input?.end ?? args.selection.end ?? null,
      status: e?.status ?? 'INSUFFICIENT_DATA',
      reason: e ? null : 'NO_STORED_PORTFOLIO_FOR_SELECTED_SOURCE',
      evaluation: e,
      comparison,
      inputFingerprint: stableHash({
        primary: input?.inputFingerprint ?? args.selection,
        reference: other?.inputFingerprint ?? reference,
      }),
    };
    if (e)
      logger.info(
        {
          portfolioId: e.provenance.portfolioId,
          strategyVersion: e.provenance.strategyVersion,
          source: e.provenance.source,
          start: e.provenance.start,
          end: e.provenance.end,
          status: e.status,
          quality: e.quality.status,
          candidates: e.signalFunnel.buyCandidates,
          segments: e.rows.segments.length,
          completed: e.statistics.completedPositions,
        },
        'Analytics metrics, signals and research checks complete',
      );
    let output: unknown;
    if (args.command === 'report') {
      const report = await saveEvaluation(db.db, body),
        directory = await generateAnalyticsReport(report, args.output);
      logger.info(
        {
          evaluationId: report.id,
          reportVersion: report.reportVersion,
          directory,
          status: report.status,
        },
        'Analytics report generated',
      );
      output = {
        evaluationId: report.id,
        directory,
        status: report.status,
        source: report.source,
        reason: report.reason,
        portfolio: report.evaluation?.portfolio ?? null,
      };
    } else if (args.command === 'trades' || args.command === 'signals')
      output = {
        source: body.source,
        status: body.status,
        reason: body.reason,
        rows: e?.rows[args.command] ?? [],
      };
    else if (args.command === 'compare') output = comparison;
    else if (e) {
      const { rows, ...summary } = e;
      void rows;
      output = summary;
    } else output = body;
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    await db.close();
  }
}
if (process.argv[1]?.endsWith('/analytics/cli.js')) {
  dotenv({ quiet: true });
  void main().catch((error: unknown) => {
    createLogger('info').error(
      safeError(error),
      'Analytics failed. Check source, portfolio, period and migrations.',
    );
    process.exitCode = 1;
  });
}
