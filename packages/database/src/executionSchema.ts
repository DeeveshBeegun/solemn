import { sql } from 'drizzle-orm';
import { forwardAccounts } from './forwardSchema.js';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  foreignKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import type { ExecutionAudit, ExecutionConfig } from '@solemn/shared';
import { backtestRuns } from './backtestSchema.js';
import { orders } from './schema.js';
import { paperPortfolios } from './paperSchema.js';
export const executionSimulationAttempts = pgTable(
  'execution_simulation_attempts',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').references(() => backtestRuns.id),
    forwardPortfolioId: uuid('forward_portfolio_id').references(
      () => forwardAccounts.portfolioId,
    ),
    orderId: uuid('order_id').notNull().unique(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => paperPortfolios.id),
    modelVersion: text('model_version').notNull(),
    outcome: text('outcome').notNull(),
    executedAt: timestamp('executed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    payload: jsonb('payload').$type<ExecutionAudit>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.orderId, t.portfolioId],
      foreignColumns: [orders.id, orders.portfolioId],
    }),
    index('execution_attempts_run_idx').on(t.runId),
    check(
      'execution_attempt_scope',
      sql`(${t.runId} IS NOT NULL AND ${t.forwardPortfolioId} IS NULL) OR (${t.runId} IS NULL AND ${t.forwardPortfolioId} IS NOT NULL AND ${t.forwardPortfolioId} = ${t.portfolioId})`,
    ),
  ],
);
export const backtestScenarios = pgTable(
  'backtest_scenarios',
  {
    id: uuid('id').primaryKey(),
    experimentId: uuid('experiment_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id),
    name: text('name').notNull(),
    configuration: jsonb('configuration')
      .$type<
        ExecutionConfig | { modelVersion: 'WEEK6_REFERENCE'; seed: number }
      >()
      .notNull(),
  },
  (t) => [
    unique('backtest_scenario_experiment_name').on(t.experimentId, t.name),
  ],
);
