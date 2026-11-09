import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { paperPortfolios } from './paperSchema.js';

const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });

export const operationalStates = [
  'STARTING',
  'RECOVERING',
  'RUNNING',
  'DEGRADED',
  'PAUSED',
  'HALTED',
  'STOPPING',
  'STOPPED',
] as const;
export type OperationalState = (typeof operationalStates)[number];
export type OperationalHealth = {
  checkedAt: string;
  sourceAt: string;
  reconciledAt: string | null;
  market:
    | 'HEALTHY'
    | 'STALE'
    | 'DISCONNECTED'
    | 'WARMING_UP'
    | 'UNVERIFIED'
    | 'OVERLOADED';
  reason: string;
  impairedSince: string | null;
  database: 'HEALTHY' | 'FAILED';
  queryMs: number | null;
  queueDepth: number | null;
  protectiveExits: boolean;
};

export const forwardAccounts = pgTable(
  'forward_accounts',
  {
    portfolioId: uuid('portfolio_id')
      .primaryKey()
      .references(() => paperPortfolios.id),
    mode: text('mode', { enum: ['REPLAY', 'LIVE_READ_ONLY'] }).notNull(),
    profileHash: text('profile_hash').notNull(),
    paused: boolean('paused').notNull().default(false),
    status: text('status', { enum: operationalStates }).notNull(),
    ownerPid: integer('owner_pid'),
    opsVersion: integer('ops_version').notNull().default(0),
    opsReason: text('ops_reason')
      .notNull()
      .default('UNVERIFIED_PREVIOUS_STATE'),
    opsActor: text('ops_actor').notNull().default('migration'),
    opsUpdatedAt: time('ops_updated_at').notNull().defaultNow(),
    health: jsonb('operational_health').$type<OperationalHealth>(),
    sessionId: uuid('session_id').notNull(),
    startedAt: time('started_at').notNull(),
    heartbeatAt: time('heartbeat_at').notNull(),
    checkpoint: jsonb('checkpoint').$type<unknown>().notNull(),
  },
  (t) => [
    check(
      'forward_operational_status_check',
      sql`${t.status} IN ('STARTING','RECOVERING','RUNNING','DEGRADED','PAUSED','HALTED','STOPPING','STOPPED') AND ${t.paused} = (${t.status} = 'PAUSED')`,
    ),
  ],
);

export const forwardRuntimeEvents = pgTable(
  'forward_runtime_events',
  {
    id: uuid('id').primaryKey(),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => forwardAccounts.portfolioId),
    sessionId: uuid('session_id').notNull(),
    kind: text('kind').notNull(),
    at: time('at').notNull(),
    recordedAt: time('recorded_at').defaultNow().notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('forward_events_account_kind_time_idx').on(
      t.portfolioId,
      t.kind,
      t.at,
    ),
  ],
);
