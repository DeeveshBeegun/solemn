import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  unique,
  check,
  index,
} from 'drizzle-orm/pg-core';
import type {
  PaperAccountDefinition,
  PaperActionResult,
  PaperCommand,
  PaperOrderRecord,
  PaperPortfolioState,
  PaperPosting,
} from '@solemn/shared';
import { strategyRuns } from './strategySchema.js';
const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
export const paperPortfolios = pgTable(
  'paper_portfolios',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    mode: text('mode').notNull(),
    dataMode: text('data_mode').notNull(),
    strategyRunId: uuid('strategy_run_id')
      .notNull()
      .references(() => strategyRuns.id),
    configHash: text('config_hash').notNull(),
    definition: jsonb('definition').$type<PaperAccountDefinition>().notNull(),
    state: jsonb('state').$type<PaperPortfolioState>().notNull(),
    availableCashUsd: numeric('available_cash_usd').notNull(),
    reservedCashUsd: numeric('reserved_cash_usd').notNull(),
    equityUsd: numeric('equity_usd').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    lastEventHash: text('last_event_hash').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [
    check(
      'paper_portfolio_modes',
      sql`${t.mode} = 'PAPER' AND ${t.dataMode} IN ('FIXTURE','FORWARD_REPLAY','FORWARD_LIVE')`,
    ),
    check(
      'paper_portfolio_cash',
      sql`${t.availableCashUsd} >= 0 AND ${t.reservedCashUsd} >= 0 AND ${t.equityUsd} >= 0 AND scale(${t.availableCashUsd}) <= 18 AND scale(${t.reservedCashUsd}) <= 18 AND scale(${t.equityUsd}) <= 18 AND ${t.availableCashUsd} < 1e60 AND ${t.reservedCashUsd} < 1e60 AND ${t.equityUsd} < 1e60`,
    ),
    check(
      'paper_portfolio_snapshot',
      sql`${t.availableCashUsd} = (${t.state}->>'availableCashUsd')::numeric AND ${t.reservedCashUsd} = (${t.state}->>'reservedCashUsd')::numeric AND ${t.equityUsd} = (${t.state}->>'equityUsd')::numeric AND ${t.status} = ${t.state}->>'status' AND ${t.version} >= 1`,
    ),
    index('paper_portfolio_status_idx').on(t.status),
  ],
);
export const portfolioBalanceEvents = pgTable(
  'portfolio_balance_events',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => paperPortfolios.id),
    sequence: integer('sequence').notNull(),
    timestamp: time('timestamp').notNull(),
    command: jsonb('command').$type<PaperCommand | null>(),
    inputHash: text('input_hash').notNull(),
    postings: jsonb('postings').$type<PaperPosting[]>().notNull(),
    orders: jsonb('orders').$type<PaperOrderRecord[]>().notNull(),
    result: jsonb('result').$type<PaperActionResult>().notNull(),
    stateAfter: jsonb('state_after').$type<PaperPortfolioState>().notNull(),
    previousHash: text('previous_hash'),
    eventHash: text('event_hash').notNull(),
  },
  (t) => [
    unique('paper_ledger_sequence').on(t.portfolioId, t.sequence),
    check('paper_ledger_positive_sequence', sql`${t.sequence} > 0`),
    index('paper_ledger_time_idx').on(t.portfolioId, t.timestamp),
  ],
);
