import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  numeric,
  primaryKey,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core';
import type {
  BacktestPlan,
  BacktestResult,
  DatasetQuality,
  EquitySnapshot,
  ExecutionIntent,
  HistoricalEvent,
  HistoricalManifest,
} from '@solemn/shared';
import { paperPortfolios } from './paperSchema.js';
import { strategyRuns } from './strategySchema.js';
const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
export const backtestDatasets = pgTable(
  'backtest_datasets',
  {
    id: uuid('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    version: text('version').notNull(),
    status: text('status').notNull(),
    fingerprint: text('fingerprint'),
    manifest: jsonb('manifest').$type<HistoricalManifest>().notNull(),
    quality: jsonb('quality').$type<DatasetQuality>(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('backtest_dataset_source_version').on(t.sourceId, t.version),
    check(
      'backtest_dataset_state',
      sql`${t.status} IN ('IMPORTING', 'READY') AND (${t.status} != 'READY' OR (${t.fingerprint} IS NOT NULL AND ${t.quality} IS NOT NULL))`,
    ),
  ],
);
export const backtestDatasetEvents = pgTable(
  'backtest_dataset_events',
  {
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => backtestDatasets.id),
    id: uuid('id').notNull(),
    sortKey: text('sort_key').notNull(),
    availableAt: time('available_at').notNull(),
    eventAt: time('event_at'),
    kind: text('kind').notNull(),
    mint: text('mint').notNull(),
    poolAddress: text('pool_address').notNull(),
    payload: jsonb('payload').$type<HistoricalEvent>().notNull(),
    payloadHash: text('payload_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.id] }),
    unique('backtest_dataset_sort_key').on(t.datasetId, t.sortKey),
    index('backtest_dataset_availability_idx').on(t.datasetId, t.availableAt),
    index('backtest_dataset_replay_order_idx').on(
      t.datasetId,
      sql`${t.sortKey} COLLATE "C"`,
    ),
  ],
);
export const backtestRuns = pgTable(
  'backtest_runs',
  {
    id: uuid('id').primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => backtestDatasets.id),
    datasetFingerprint: text('dataset_fingerprint').notNull(),
    portfolioId: uuid('portfolio_id')
      .unique()
      .references(() => paperPortfolios.id),
    strategyRunId: uuid('strategy_run_id')
      .unique()
      .references(() => strategyRuns.id),
    configHash: text('config_hash').notNull(),
    plan: jsonb('plan').$type<BacktestPlan>().notNull(),
    status: text('status').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
    completedAt: time('completed_at'),
    errorCode: text('error_code'),
  },
  (t) => [
    check(
      'backtest_run_status',
      sql`${t.status} IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
    index('backtest_run_dataset_idx').on(t.datasetId, t.createdAt),
  ],
);
export const backtestEquitySnapshots = pgTable(
  'backtest_equity_snapshots',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id),
    timestamp: time('timestamp').notNull(),
    availableCashUsd: numeric('available_cash_usd').notNull(),
    reservedCashUsd: numeric('reserved_cash_usd').notNull(),
    markedPositionsUsd: numeric('marked_positions_usd'),
    totalEquityUsd: numeric('total_equity_usd'),
    realizedPnlUsd: numeric('realized_pnl_usd').notNull(),
    unrealizedPnlUsd: numeric('unrealized_pnl_usd'),
    drawdownPercent: numeric('drawdown_percent'),
    valuationQuality: text('valuation_quality').notNull(),
    payload: jsonb('payload').$type<EquitySnapshot>().notNull(),
  },
  (t) => [
    unique('backtest_equity_time').on(t.runId, t.timestamp),
    index('backtest_equity_run_time_idx').on(t.runId, t.timestamp),
    check(
      'backtest_equity_quality',
      sql`(${t.valuationQuality} = 'RELIABLE' AND ${t.totalEquityUsd} IS NOT NULL AND ${t.markedPositionsUsd} IS NOT NULL AND ${t.unrealizedPnlUsd} IS NOT NULL AND ${t.drawdownPercent} IS NOT NULL) OR (${t.valuationQuality} = 'UNCERTAIN' AND ${t.totalEquityUsd} IS NULL AND ${t.markedPositionsUsd} IS NULL AND ${t.unrealizedPnlUsd} IS NULL AND ${t.drawdownPercent} IS NULL)`,
    ),
  ],
);
export const backtestExecutionIntents = pgTable(
  'backtest_execution_intents',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id),
    status: text('status').notNull(),
    dueAt: time('due_at').notNull(),
    payload: jsonb('payload').$type<ExecutionIntent>().notNull(),
  },
  (t) => [index('backtest_intents_run_status_idx').on(t.runId, t.status)],
);
export const backtestResults = pgTable('backtest_results', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => backtestRuns.id),
  payload: jsonb('payload').$type<BacktestResult>().notNull(),
  generatedAt: time('generated_at').notNull().defaultNow(),
});
