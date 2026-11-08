import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import type {
  MarketCandle,
  MarketCorrection,
  MarketDataset,
  NormalizedMarketTrade,
  StrategyDecision,
  StrategyPolicy,
} from '@solemn/shared';

const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });
export const strategyMode = pgEnum('strategy_mode', [
  'FIXTURE',
  'LIVE_NOT_READY',
]);
export const strategyOutcome = pgEnum('strategy_outcome', [
  'BUY_CANDIDATE',
  'NO_SIGNAL',
  'INSUFFICIENT_DATA',
  'BLOCKED_BY_RISK',
]);
export const strategyRuns = pgTable(
  'strategy_runs',
  {
    id: uuid('id').primaryKey(),
    mode: strategyMode('mode').notNull(),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    configHash: text('config_hash').notNull(),
    riskPolicyHash: text('risk_policy_hash').notNull(),
    config: jsonb('config').$type<StrategyPolicy>().notNull(),
    datasetHash: text('dataset_hash'),
    dataset: jsonb('dataset').$type<MarketDataset>(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [unique('strategy_runs_id_mode').on(t.id, t.mode)],
);

export const marketTradeObservations = pgTable(
  'market_trade_observations',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => strategyRuns.id),
    id: uuid('id').notNull(),
    tokenMint: text('token_mint').notNull(),
    poolAddress: text('pool_address'),
    source: text('source').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    timestamp: time('timestamp').notNull(),
    receivedAt: time('received_at').notNull(),
    payload: jsonb('payload').$type<NormalizedMarketTrade>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    unique('market_trade_source_identity').on(
      t.runId,
      t.source,
      t.sourceEventId,
    ),
    index('market_trade_token_time_idx').on(t.tokenMint, t.timestamp),
  ],
);

export const marketCoverageObservations = pgTable(
  'market_coverage_observations',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => strategyRuns.id),
    id: uuid('id').notNull(),
    tokenMint: text('token_mint').notNull(),
    poolAddress: text('pool_address').notNull(),
    start: time('start').notNull(),
    end: time('end').notNull(),
    availableAt: time('available_at').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    index('market_coverage_token_time_idx').on(t.tokenMint, t.start),
    check(
      'market_coverage_interval',
      sql`${t.start} < ${t.end} AND ${t.end} <= ${t.availableAt}`,
    ),
  ],
);

export const marketCandles = pgTable(
  'market_candles',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => strategyRuns.id),
    id: uuid('id').notNull(),
    tokenMint: text('token_mint').notNull(),
    poolAddress: text('pool_address').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    payload: jsonb('payload').$type<MarketCandle>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    unique('market_candle_run_interval').on(
      t.runId,
      t.tokenMint,
      t.poolAddress,
      t.startTime,
    ),
    index('market_candle_token_time_idx').on(t.tokenMint, t.endTime),
  ],
);

export const marketCorrections = pgTable(
  'market_corrections',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => strategyRuns.id),
    id: uuid('id').notNull(),
    tokenMint: text('token_mint').notNull(),
    poolAddress: text('pool_address').notNull(),
    receivedAt: time('received_at').notNull(),
    reason: text('reason').notNull(),
    payload: jsonb('payload').$type<MarketCorrection>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    index('market_correction_time_idx').on(t.tokenMint, t.receivedAt),
  ],
);

export const strategyDecisions = pgTable(
  'strategy_decisions',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull(),
    mode: strategyMode('mode').notNull(),
    tokenMint: text('token_mint').notNull(),
    poolAddress: text('pool_address'),
    timestamp: time('timestamp').notNull(),
    candleId: uuid('candle_id'),
    outcome: strategyOutcome('outcome').notNull(),
    opportunityKey: text('opportunity_key'),
    signalId: uuid('signal_id'),
    payload: jsonb('payload').$type<StrategyDecision>().notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId, t.mode],
      foreignColumns: [strategyRuns.id, strategyRuns.mode],
    }),
    foreignKey({
      columns: [t.runId, t.candleId],
      foreignColumns: [marketCandles.runId, marketCandles.id],
    }),
    unique('strategy_signal_opportunity').on(t.runId, t.opportunityKey),
    unique('strategy_candidate_id').on(t.signalId),
    index('strategy_decision_token_time_idx').on(t.tokenMint, t.timestamp),
    index('strategy_decision_outcome_idx').on(t.outcome, t.timestamp),
    check(
      'strategy_fixture_candidates_only',
      sql`${t.outcome} != 'BUY_CANDIDATE' OR (${t.mode} = 'FIXTURE' AND ${t.opportunityKey} IS NOT NULL AND ${t.signalId} IS NOT NULL AND ${t.payload}->'candidate' IS NOT NULL AND ${t.payload}->'candidate' != 'null'::jsonb)`,
    ),
  ],
);
