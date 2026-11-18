import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  backtestEquitySnapshots,
  backtestRuns,
  createDatabase,
  forwardRuntimeEvents,
  marketEvents,
  paperPortfolios,
  strategyDecisions,
  tokenRiskAssessments,
  tokens,
  trades,
} from '@solemn/database';
import type { Database } from '@solemn/database';

type Dataset = {
  label: string;
  description: string;
  table: PgTable;
  date: AnyPgColumn;
  id: AnyPgColumn;
  columns: Record<string, AnyPgColumn>;
  selectColumns: string[];
  filter?: { label: string; column: AnyPgColumn; uuid?: true };
};
const datasets = {
  tokens: {
    label: 'Tokens',
    selectColumns: ['source', 'riskStatus', 'migrationStatus'],
    description:
      'Token metadata, migration state, and the latest risk status. Ordered by discovery time.',
    table: tokens,
    date: tokens.discoveredAt,
    id: tokens.mintAddress,
    columns: {
      discoveredAt: tokens.discoveredAt,
      symbol: tokens.symbol,
      name: tokens.name,
      mint: tokens.mintAddress,
      source: tokens.sourcePlatform,
      riskStatus: tokens.riskStatus,
      migrationStatus: tokens.migrationStatus,
    },
    filter: { label: 'Token mint', column: tokens.mintAddress },
  },
  market: {
    label: 'Market events',
    selectColumns: ['eventType', 'source'],
    description:
      'Scanner observations saved from market feeds. Ordered by ingestion time.',
    table: marketEvents,
    date: marketEvents.ingestedAt,
    id: marketEvents.id,
    columns: {
      ingestedAt: marketEvents.ingestedAt,
      eventType: marketEvents.eventType,
      mint: marketEvents.tokenMint,
      source: marketEvents.source,
      signature: marketEvents.transactionSignature,
    },
    filter: { label: 'Token mint', column: marketEvents.tokenMint },
  },
  risk: {
    label: 'Risk assessments',
    selectColumns: ['status'],
    description:
      'Stored token risk checks and their validity windows. Ordered by assessment time.',
    table: tokenRiskAssessments,
    date: tokenRiskAssessments.assessedAt,
    id: tokenRiskAssessments.id,
    columns: {
      assessedAt: tokenRiskAssessments.assessedAt,
      mint: tokenRiskAssessments.tokenMint,
      status: tokenRiskAssessments.status,
      policyVersion: tokenRiskAssessments.policyVersion,
      validUntil: tokenRiskAssessments.validUntil,
    },
    filter: { label: 'Token mint', column: tokenRiskAssessments.tokenMint },
  },
  decisions: {
    label: 'Strategy decisions',
    selectColumns: ['outcome', 'mode'],
    description:
      'Recorded outcomes from the strategy, including decisions that did not generate a signal. Ordered by market timestamp.',
    table: strategyDecisions,
    date: strategyDecisions.timestamp,
    id: strategyDecisions.id,
    columns: {
      timestamp: strategyDecisions.timestamp,
      outcome: strategyDecisions.outcome,
      mode: strategyDecisions.mode,
      mint: strategyDecisions.tokenMint,
      runId: strategyDecisions.runId,
    },
    filter: { label: 'Token mint', column: strategyDecisions.tokenMint },
  },
  portfolios: {
    label: 'Paper portfolios',
    selectColumns: ['dataMode', 'status'],
    description:
      'Persisted paper accounts and cash balances. Ordered by last update.',
    table: paperPortfolios,
    date: paperPortfolios.updatedAt,
    id: paperPortfolios.id,
    columns: {
      updatedAt: paperPortfolios.updatedAt,
      name: paperPortfolios.name,
      dataMode: paperPortfolios.dataMode,
      status: paperPortfolios.status,
      availableCashUsd: paperPortfolios.availableCashUsd,
      reservedCashUsd: paperPortfolios.reservedCashUsd,
      portfolioId: paperPortfolios.id,
    },
  },
  trades: {
    label: 'Paper fills',
    selectColumns: ['side'],
    description:
      'Simulated executions from paper accounts, including replay and backtests. Ordered by execution timestamp.',
    table: trades,
    date: trades.timestamp,
    id: trades.id,
    columns: {
      timestamp: trades.timestamp,
      side: trades.side,
      mint: trades.tokenMint,
      notionalUsd: trades.notionalUsd,
      feesUsd: trades.feesUsd,
      portfolioId: trades.portfolioId,
    },
    filter: { label: 'Portfolio ID', column: trades.portfolioId, uuid: true },
  },
  forward: {
    label: 'Forward events',
    selectColumns: ['kind'],
    description:
      'Recorded forward worker activity. Ordered by database recording time, with the event timestamp shown separately.',
    table: forwardRuntimeEvents,
    date: forwardRuntimeEvents.recordedAt,
    id: forwardRuntimeEvents.id,
    columns: {
      recordedAt: forwardRuntimeEvents.recordedAt,
      eventAt: forwardRuntimeEvents.at,
      kind: forwardRuntimeEvents.kind,
      portfolioId: forwardRuntimeEvents.portfolioId,
      sessionId: forwardRuntimeEvents.sessionId,
    },
    filter: {
      label: 'Portfolio ID',
      column: forwardRuntimeEvents.portfolioId,
      uuid: true,
    },
  },
  backtests: {
    label: 'Backtest runs',
    selectColumns: ['status'],
    description:
      'Saved backtest runs and their execution status. Select a run to chart its stored paper equity.',
    table: backtestRuns,
    date: backtestRuns.createdAt,
    id: backtestRuns.id,
    columns: {
      createdAt: backtestRuns.createdAt,
      status: backtestRuns.status,
      runId: backtestRuns.id,
      datasetId: backtestRuns.datasetId,
      completedAt: backtestRuns.completedAt,
      errorCode: backtestRuns.errorCode,
    },
  },
} satisfies Record<string, Dataset>;

export const dataCatalog = Object.entries<Dataset>(datasets).map(
  ([key, dataset]) => ({
    key,
    label: dataset.label,
    description: dataset.description,
    columns: Object.keys(dataset.columns),
    selectColumns: dataset.selectColumns,
    filterLabel: dataset.filter?.label,
  }),
);

export class DataQueryError extends Error {}

const pageSize = 50;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function day(value: string | null) {
  if (!value) return undefined;
  const timestamp = new Date(value + 'T00:00:00.000Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString().slice(0, 10) !== value ||
    value.startsWith('0000-')
  )
    throw new DataQueryError('Enter a valid calendar date.');
  return timestamp;
}

function cursorFor(at: string, id: string) {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

function readCursor(
  value: string | null,
  requireUuid: boolean,
): [string, string] | undefined {
  if (!value) return;
  try {
    if (!/^[a-zA-Z0-9_-]{1,512}$/.test(value)) throw new Error();
    const [at, id] = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof at === 'string' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(at) &&
      Number.isFinite(Date.parse(at)) &&
      typeof id === 'string' &&
      id.length > 0 &&
      id.length <= 128 &&
      (requireUuid ? uuid.test(id) : !id.includes('\0'))
    )
      return [at, id];
  } catch {
    // Keep decoder internals out of user-facing errors.
  }
  throw new DataQueryError('The page cursor is invalid. Refresh the results.');
}

async function readDatabase<T>(read: (db: Database) => Promise<T>) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDatabase(url);
  try {
    return await db.db.transaction(read, {
      accessMode: 'read only',
      isolationLevel: 'repeatable read',
    });
  } finally {
    await db.close();
  }
}

export async function readDataset(params: URLSearchParams) {
  const key = params.get('dataset') ?? '';
  if (!Object.hasOwn(datasets, key))
    throw new DataQueryError('Select a supported dataset.');
  const dataset: Dataset = datasets[key as keyof typeof datasets];
  const from = day(params.get('from'));
  const through = day(params.get('through'));
  if (from && through && from > through)
    throw new DataQueryError(
      'The end date must be on or after the start date.',
    );
  const filter = params.get('filter')?.trim();
  if (
    filter &&
    (!dataset.filter ||
      filter.length > 128 ||
      !(dataset.filter.uuid ? uuid.test(filter) : !filter.includes('\0')))
  )
    throw new DataQueryError(
      'Enter a valid ' +
        (dataset.filter?.label.toLowerCase() ?? 'filter') +
        '.',
    );
  const cursor = readCursor(params.get('cursor'), key !== 'tokens');
  const columnConditions = [];
  for (const [parameter, value] of params) {
    if (!parameter.startsWith('column.')) continue;
    const key = parameter.slice('column.'.length);
    if (
      !Object.hasOwn(dataset.columns, key) ||
      value.length > 128 ||
      value.includes('\0') ||
      params.getAll(parameter).length !== 1
    )
      throw new DataQueryError(
        'Use a valid column filter of up to 128 characters.',
      );
    const text = value.trim();
    if (!text) continue;
    const column = dataset.columns[key]!;
    if (dataset.selectColumns.includes(key)) {
      columnConditions.push(
        eq(sql`lower(cast(${column} as text))`, text.toLowerCase()),
      );
      continue;
    }
    const searchable =
      column.columnType === 'PgTimestampString'
        ? sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        : sql`cast(${column} as text)`;
    const escaped = text.replace(/[\\%_]/g, '\\$&');
    columnConditions.push(ilike(searchable, `%${escaped}%`));
  }
  const where = and(
    from ? gte(dataset.date, from.toISOString()) : undefined,
    through
      ? lte(
          dataset.date,
          through.toISOString().slice(0, 10) + 'T23:59:59.999999Z',
        )
      : undefined,
    filter && dataset.filter ? eq(dataset.filter.column, filter) : undefined,
    ...columnConditions,
  );

  return readDatabase(async (db) => {
    const rows = await db
      .select({
        ...dataset.columns,
        cursorDate: dataset.date,
        cursorId: dataset.id,
      })
      .from(dataset.table)
      .where(
        and(
          where,
          cursor
            ? or(
                lt(dataset.date, cursor[0]),
                and(eq(dataset.date, cursor[0]), lt(dataset.id, cursor[1])),
              )
            : undefined,
        ),
      )
      .orderBy(desc(dataset.date), desc(dataset.id))
      .limit(pageSize + 1);
    const last = rows[pageSize - 1];
    const next =
      rows.length > pageSize &&
      typeof last?.cursorDate === 'string' &&
      typeof last.cursorId === 'string'
        ? cursorFor(last.cursorDate, last.cursorId)
        : null;
    const utcDay = sql<string>`(${dataset.date} at time zone 'UTC')::date::text`;
    const timeline = cursor
      ? null
      : (
          await db
            .select({ day: utcDay, count: count() })
            .from(dataset.table)
            .where(where)
            .groupBy(utcDay)
            .orderBy(desc(utcDay))
            .limit(14)
        ).reverse();

    const columnOptions: Record<string, string[]> = {};
    if (!cursor) {
      for (const key of dataset.selectColumns) {
        const column = dataset.columns[key]!;
        const stored = await db
          .selectDistinct({ value: column })
          .from(dataset.table)
          .orderBy(column);
        columnOptions[key] = [
          ...new Set([
            ...(column.enumValues ?? []),
            ...stored
              .map(({ value }) => value)
              .filter(
                (value): value is string =>
                  typeof value === 'string' && value.length > 0,
              ),
          ]),
        ].sort();
      }
    }
    return {
      columnOptions,
      rows: rows.slice(0, pageSize).map(({ cursorDate, cursorId, ...row }) => ({
        ...row,
        // Use ISO timestamps in the browser while retaining DB precision in the cursor.
        ...Object.fromEntries(
          Object.entries(row)
            .filter(
              ([key, value]) =>
                value !== null &&
                (key.endsWith('At') ||
                  key === 'timestamp' ||
                  key === 'validUntil'),
            )
            .map(([key, value]) => [
              key,
              new Date(String(value)).toISOString(),
            ]),
        ),
      })),
      next,
      timeline,
    };
  });
}

export async function readEquity(runId: string) {
  if (!uuid.test(runId))
    throw new DataQueryError('Select a valid backtest run.');
  return readDatabase(async (db) => {
    const points = await db
      .select({
        at: backtestEquitySnapshots.timestamp,
        equity: backtestEquitySnapshots.totalEquityUsd,
      })
      .from(backtestEquitySnapshots)
      .where(eq(backtestEquitySnapshots.runId, runId))
      .orderBy(
        desc(backtestEquitySnapshots.timestamp),
        desc(backtestEquitySnapshots.id),
      )
      .limit(251);
    return {
      truncated: points.length > 250,
      points: points
        .slice(0, 250)
        .reverse()
        .map((point) => ({
          ...point,
          at: new Date(point.at).toISOString(),
        })),
    };
  });
}
