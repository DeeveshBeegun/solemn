import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { paperPortfolios } from './paperSchema.js';

const time = (name: string) =>
  timestamp(name, { mode: 'string', withTimezone: true });
export const strategyEvaluationPeriods = pgTable(
  'strategy_evaluation_periods',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => paperPortfolios.id),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    configurationHash: text('configuration_hash').notNull(),
    source: text('source').notNull(),
    kind: text('kind', {
      enum: ['DEVELOPMENT', 'VALIDATION', 'HOLDOUT', 'FORWARD'],
    }).notNull(),
    startAt: time('start_at').notNull(),
    endAt: time('end_at').notNull(),
    registeredAt: time('registered_at').defaultNow().notNull(),
  },
  (t) => [
    check(
      'strategy_evaluation_period_order',
      sql`${t.startAt} < ${t.endAt} AND ${t.registeredAt} < ${t.startAt}`,
    ),
    index('strategy_evaluation_period_strategy_idx').on(
      t.strategyId,
      t.startAt,
      t.endAt,
    ),
  ],
);

export const strategyEvaluations = pgTable(
  'strategy_evaluations',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id').references(() => paperPortfolios.id),
    periodId: uuid('period_id').references(() => strategyEvaluationPeriods.id),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: text('strategy_version'),
    source: text('source').notNull(),
    configurationHash: text('configuration_hash'),
    inputFingerprint: text('input_fingerprint').notNull(),
    status: text('status').notNull(),
    reportVersion: text('report_version').notNull(),
    startAt: time('start_at'),
    endAt: time('end_at'),
    generatedAt: time('generated_at').defaultNow().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
  },
  (t) => [
    index('strategy_evaluations_portfolio_time_idx').on(
      t.portfolioId,
      t.startAt,
      t.endAt,
    ),
  ],
);
