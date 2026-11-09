import {
  index,
  uniqueIndex,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { forwardAccounts } from './forwardSchema.js';

const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
export const operationsSeverities = ['INFO', 'WARNING', 'CRITICAL'] as const;

export const operationalAuditEvents = pgTable(
  'operational_audit_events',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => forwardAccounts.portfolioId),
    sessionId: uuid('session_id').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity', { enum: operationsSeverities }).notNull(),
    actor: text('actor').notNull(),
    source: text('source').notNull(),
    reason: text('reason').notNull(),
    at: time('at').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('operational_audit_account_time_idx').on(t.portfolioId, t.at)],
);

export const operationalIncidents = pgTable(
  'operational_incidents',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => forwardAccounts.portfolioId),
    category: text('category').notNull(),
    severity: text('severity', { enum: operationsSeverities }).notNull(),
    openedAt: time('opened_at').notNull(),
    resolvedAt: time('resolved_at'),
    resolution: text('resolution'),
  },
  (t) => [
    index('operational_incident_account_open_idx').on(
      t.portfolioId,
      t.resolvedAt,
    ),
    uniqueIndex('operational_incident_active_category_idx')
      .on(t.portfolioId, t.category)
      .where(sql`${t.resolvedAt} is null`),
  ],
);
