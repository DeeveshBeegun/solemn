import { sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  text,
  uuid,
  integer,
  bigint,
  timestamp,
  numeric,
  jsonb,
  index,
  unique,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
export * from './strategySchema.js';
import {
  executionModeSchema,
  orderStatusSchema,
  riskStatusSchema,
  sideSchema,
} from '@solemn/shared';
import type {
  MarketEvent,
  TradingSignal,
  TokenRiskAssessment,
} from '@solemn/shared';

export const riskStatus = pgEnum('risk_status', riskStatusSchema.enum);
export const orderStatus = pgEnum('order_status', orderStatusSchema.enum);
export const executionMode = pgEnum('execution_mode', executionModeSchema.enum);
export const side = pgEnum('order_side', sideSchema.enum);
export const signalType = pgEnum('signal_type', ['BUY', 'SELL', 'HOLD']);
export const positionStatus = pgEnum('position_status', ['OPEN', 'CLOSED']);
export const migrationStatus = pgEnum('migration_status', [
  'UNKNOWN',
  'MIGRATED',
]);
const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
// pg returns NUMERIC as strings; never register a parser that converts it to Number.
// Unconstrained NUMERIC + CHECK rejects excess precision instead of silently rounding it.
const amount = (name: string) => numeric(name);
const exactAmounts = (...columns: SQLWrapper[]) =>
  sql.join(
    columns.map(
      (column) =>
        sql`(scale(${column}) <= 18 AND abs(${column}) < 1e60::numeric)`,
    ),
    sql` AND `,
  );

export const tokens = pgTable(
  'tokens',
  {
    mintAddress: text('mint_address').primaryKey(),
    name: text('name'),
    symbol: text('symbol'),
    decimals: integer('decimals'),
    createdAt: time('created_at'),
    discoveredAt: time('discovered_at').notNull(),
    sourcePlatform: text('source_platform').notNull(),
    poolAddress: text('pool_address'),
    riskStatus: riskStatus('risk_status').notNull().default('UNKNOWN'),
    creatorAddress: text('creator_address'),
    bondingCurveAddress: text('bonding_curve_address'),
    migrationStatus: migrationStatus('migration_status')
      .notNull()
      .default('UNKNOWN'),
    migratedAt: time('migrated_at'),
    migrationObservedAt: time('migration_observed_at'),
    migrationVenue: text('migration_venue'),
    riskRequestId: uuid('risk_request_id'),
    riskRequestedAt: time('risk_requested_at'),
    riskTrigger: text('risk_trigger'),
    riskNextAssessmentAt: time('risk_next_assessment_at'),
    riskLeaseUntil: time('risk_lease_until'),
    riskAttemptCount: integer('risk_attempt_count').notNull().default(0),
    riskAssessedAt: time('risk_assessed_at'),
    riskValidUntil: time('risk_valid_until'),
    latestRiskAssessmentId: uuid('latest_risk_assessment_id').references(
      (): AnyPgColumn => tokenRiskAssessments.id,
    ),
  },
  (t) => [
    check('tokens_decimals_range', sql`${t.decimals} BETWEEN 0 AND 255`),
    index('tokens_discovered_at_idx').on(t.discoveredAt),
    index('tokens_migration_idx').on(t.migrationStatus, t.migrationObservedAt),
    index('tokens_risk_work_idx').on(t.riskNextAssessmentAt, t.riskLeaseUntil),
    index('tokens_risk_eligibility_idx').on(t.riskStatus, t.riskValidUntil),
    check('tokens_risk_attempts_nonnegative', sql`${t.riskAttemptCount} >= 0`),
  ],
);

export const tokenRiskAssessments = pgTable(
  'token_risk_assessments',
  {
    id: uuid('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    requestId: uuid('request_id').notNull(),
    attempt: integer('attempt').notNull(),
    requestedAt: time('requested_at').notNull(),
    status: riskStatus('status').notNull(),
    reasons: jsonb('reasons').$type<TokenRiskAssessment['reasons']>().notNull(),
    checks: jsonb('checks').$type<TokenRiskAssessment['checks']>().notNull(),
    policy: jsonb('policy').$type<TokenRiskAssessment['policy']>().notNull(),
    policyVersion: text('policy_version').notNull(),
    policyHash: text('policy_hash').notNull(),
    evidence: jsonb('evidence')
      .$type<TokenRiskAssessment['evidence']>()
      .notNull(),
    assessedAt: time('assessed_at').notNull(),
    validUntil: time('valid_until'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('token_risk_request_attempt_unique').on(t.requestId, t.attempt),
    index('token_risk_history_idx').on(t.tokenMint, t.assessedAt),
    index('token_risk_candidate_idx').on(t.status, t.validUntil),
    check('token_risk_attempt_positive', sql`${t.attempt} > 0`),
    check(
      'token_risk_eligible_expiry',
      sql`${t.status} != 'ELIGIBLE' OR (${t.validUntil} IS NOT NULL AND ${t.validUntil} > ${t.assessedAt})`,
    ),
  ],
);

export const marketEvents = pgTable(
  'market_events',
  {
    id: uuid('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    eventType: text('event_type').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    slot: bigint('slot', { mode: 'bigint' }),
    transactionSignature: text('transaction_signature'),
    eventAt: time('event_at'),
    ingestedAt: time('ingested_at').notNull(),
    source: text('source').notNull(),
    rawPayload: jsonb('raw_payload')
      .$type<MarketEvent['rawPayload']>()
      .notNull(),
    rawMessage: text('raw_message'),
  },
  (t) => [
    unique('market_events_source_identity').on(t.source, t.sourceEventId),
    check(
      'market_events_slot_nonnegative',
      sql`${t.slot} IS NULL OR ${t.slot} >= 0`,
    ),
    index('market_events_token_time_idx').on(t.tokenMint, t.eventAt),
    index('market_events_signature_idx').on(t.transactionSignature),
    index('market_events_source_ingestion_idx').on(t.source, t.ingestedAt),
  ],
);

export const scannerGaps = pgTable(
  'scanner_gaps',
  {
    id: uuid('id').primaryKey(),
    source: text('source').notNull(),
    startedAt: time('started_at').notNull(),
    endedAt: time('ended_at'),
    reason: text('reason').notNull(),
  },
  (t) => [
    index('scanner_gaps_source_time_idx').on(t.source, t.startedAt),
    check(
      'scanner_gaps_valid_times',
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`,
    ),
  ],
);

export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: uuid('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    timestamp: time('timestamp').notNull(),
    priceUsd: amount('price_usd').notNull(),
    poolLiquidityUsd: amount('pool_liquidity_usd').notNull(),
    volumeUsd: amount('volume_usd').notNull(),
    buyVolumeUsd: amount('buy_volume_usd').notNull(),
    sellVolumeUsd: amount('sell_volume_usd').notNull(),
    uniqueBuyerCount: integer('unique_buyer_count').notNull(),
    source: text('source').notNull(),
    observedAt: time('observed_at').notNull(),
    maxAgeMs: integer('max_age_ms').notNull(),
    volumeWindowSeconds: integer('volume_window_seconds').notNull(),
  },
  (t) => [
    unique('market_snapshots_id_token').on(t.id, t.tokenMint),
    index('market_snapshots_token_time_idx').on(t.tokenMint, t.timestamp),
    check(
      'market_snapshots_valid_amounts',
      sql`${t.priceUsd} > 0 AND ${t.poolLiquidityUsd} >= 0 AND ${t.volumeUsd} >= 0 AND ${t.buyVolumeUsd} >= 0 AND ${t.sellVolumeUsd} >= 0`,
    ),
    check(
      'market_snapshots_freshness',
      sql`${t.uniqueBuyerCount} >= 0 AND ${t.maxAgeMs} >= 0 AND ${t.volumeWindowSeconds} > 0`,
    ),
    check(
      'market_snapshots_precision',
      exactAmounts(
        t.priceUsd,
        t.poolLiquidityUsd,
        t.volumeUsd,
        t.buyVolumeUsd,
        t.sellVolumeUsd,
      ),
    ),
  ],
);

export const tradingSignals = pgTable(
  'trading_signals',
  {
    id: uuid('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    signalType: signalType('signal_type').notNull(),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    timestamp: time('timestamp').notNull(),
    explanation: text('explanation').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    riskAssessment: jsonb('risk_assessment')
      .$type<TradingSignal['riskAssessment']>()
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.snapshotId, t.tokenMint],
      foreignColumns: [marketSnapshots.id, marketSnapshots.tokenMint],
    }),
    index('trading_signals_token_time_idx').on(t.tokenMint, t.timestamp),
    index('trading_signals_snapshot_idx').on(t.snapshotId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    side: side('side').notNull(),
    executionMode: executionMode('execution_mode').notNull().default('PAPER'),
    requestedQuantity: amount('requested_quantity').notNull(),
    status: orderStatus('status').notNull().default('CREATED'),
    createdAt: time('created_at').notNull(),
    submittedAt: time('submitted_at'),
    executedAt: time('executed_at'),
    estimatedFeesUsd: amount('estimated_fees_usd').notNull(),
    actualFeesUsd: amount('actual_fees_usd'),
  },
  (t) => [
    unique('orders_id_token_side').on(t.id, t.tokenMint, t.side),
    index('orders_token_time_idx').on(t.tokenMint, t.createdAt),
    index('orders_status_idx').on(t.status),
    check('orders_paper_only', sql`${t.executionMode} = 'PAPER'`),
    check(
      'orders_valid_amounts',
      sql`${t.requestedQuantity} > 0 AND ${t.estimatedFeesUsd} >= 0 AND (${t.actualFeesUsd} IS NULL OR ${t.actualFeesUsd} >= 0)`,
    ),
    check(
      'orders_precision',
      exactAmounts(t.requestedQuantity, t.estimatedFeesUsd, t.actualFeesUsd),
    ),
    check(
      'orders_valid_times',
      sql`(${t.submittedAt} IS NULL OR ${t.submittedAt} >= ${t.createdAt}) AND (${t.executedAt} IS NULL OR (${t.submittedAt} IS NOT NULL AND ${t.executedAt} >= ${t.submittedAt}))`,
    ),
    check(
      'orders_lifecycle',
      sql`(${t.status} != 'CREATED' OR (${t.submittedAt} IS NULL AND ${t.executedAt} IS NULL AND ${t.actualFeesUsd} IS NULL)) AND (${t.status} NOT IN ('SUBMITTED', 'PARTIALLY_FILLED', 'FILLED') OR ${t.submittedAt} IS NOT NULL) AND (${t.status} NOT IN ('PARTIALLY_FILLED', 'FILLED') OR (${t.executedAt} IS NOT NULL AND ${t.actualFeesUsd} IS NOT NULL))`,
    ),
  ],
);

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    quantity: amount('quantity').notNull(),
    averageEntryPriceUsd: amount('average_entry_price_usd').notNull(),
    costBasisUsd: amount('cost_basis_usd').notNull(),
    realizedPnlUsd: amount('realized_pnl_usd').notNull(),
    unrealizedPnlUsd: amount('unrealized_pnl_usd').notNull(),
    status: positionStatus('status').notNull(),
    openedAt: time('opened_at').notNull(),
    closedAt: time('closed_at'),
  },
  (t) => [
    index('positions_token_status_idx').on(t.tokenMint, t.status),
    check(
      'positions_valid_amounts',
      sql`${t.quantity} >= 0 AND ${t.averageEntryPriceUsd} > 0 AND ${t.costBasisUsd} >= 0`,
    ),
    check(
      'positions_precision',
      exactAmounts(
        t.quantity,
        t.averageEntryPriceUsd,
        t.costBasisUsd,
        t.realizedPnlUsd,
        t.unrealizedPnlUsd,
      ),
    ),
    check(
      'positions_lifecycle',
      sql`(${t.status} = 'OPEN' AND ${t.quantity} > 0 AND ${t.closedAt} IS NULL) OR (${t.status} = 'CLOSED' AND ${t.quantity} = 0 AND ${t.closedAt} >= ${t.openedAt} AND ${t.closedAt} IS NOT NULL)`,
    ),
  ],
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    tokenMint: text('token_mint')
      .notNull()
      .references(() => tokens.mintAddress),
    side: side('side').notNull(),
    executedQuantity: amount('executed_quantity').notNull(),
    executionPriceUsd: amount('execution_price_usd').notNull(),
    feesUsd: amount('fees_usd').notNull(),
    timestamp: time('timestamp').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.orderId, t.tokenMint, t.side],
      foreignColumns: [orders.id, orders.tokenMint, orders.side],
    }),
    index('trades_order_idx').on(t.orderId),
    index('trades_token_time_idx').on(t.tokenMint, t.timestamp),
    check(
      'trades_valid_amounts',
      sql`${t.executedQuantity} > 0 AND ${t.executionPriceUsd} > 0 AND ${t.feesUsd} >= 0`,
    ),
    check(
      'trades_precision',
      exactAmounts(t.executedQuantity, t.executionPriceUsd, t.feesUsd),
    ),
  ],
);
