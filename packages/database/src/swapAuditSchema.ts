import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { paperPortfolios } from './paperSchema.js';

export const swapExecutionAssessments = pgTable(
  'swap_execution_assessments',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id').references(() => paperPortfolios.id),
    signalId: uuid('signal_id'),
    quoteId: uuid('quote_id'),
    inputMint: text('input_mint').notNull(),
    outputMint: text('output_mint').notNull(),
    inputAmount: text('input_amount').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    fingerprint: text('fingerprint').notNull(),
    assessedAt: timestamp('assessed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    payload: jsonb('payload').notNull(),
  },
  (t) => [
    index('swap_assessments_signal_idx').on(t.portfolioId, t.signalId),
    index('swap_assessments_quote_idx').on(t.quoteId),
  ],
);
