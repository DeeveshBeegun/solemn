CREATE TYPE "public"."strategy_mode" AS ENUM('FIXTURE', 'LIVE_NOT_READY');--> statement-breakpoint
CREATE TYPE "public"."strategy_outcome" AS ENUM('BUY_CANDIDATE', 'NO_SIGNAL', 'INSUFFICIENT_DATA', 'BLOCKED_BY_RISK');--> statement-breakpoint
CREATE TABLE "market_candles" (
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"token_mint" text NOT NULL,
	"pool_address" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "market_candles_run_id_id_pk" PRIMARY KEY("run_id","id"),
	CONSTRAINT "market_candle_run_interval" UNIQUE("run_id","token_mint","pool_address","start_time")
);
--> statement-breakpoint
CREATE TABLE "market_corrections" (
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"token_mint" text NOT NULL,
	"pool_address" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "market_corrections_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "market_coverage_observations" (
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"token_mint" text NOT NULL,
	"pool_address" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	CONSTRAINT "market_coverage_observations_run_id_id_pk" PRIMARY KEY("run_id","id"),
	CONSTRAINT "market_coverage_interval" CHECK ("market_coverage_observations"."start" < "market_coverage_observations"."end" AND "market_coverage_observations"."end" <= "market_coverage_observations"."available_at")
);
--> statement-breakpoint
CREATE TABLE "market_trade_observations" (
	"run_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"token_mint" text NOT NULL,
	"pool_address" text,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "market_trade_observations_run_id_id_pk" PRIMARY KEY("run_id","id"),
	CONSTRAINT "market_trade_source_identity" UNIQUE("run_id","source","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"mode" "strategy_mode" NOT NULL,
	"token_mint" text NOT NULL,
	"pool_address" text,
	"timestamp" timestamp with time zone NOT NULL,
	"candle_id" uuid,
	"outcome" "strategy_outcome" NOT NULL,
	"opportunity_key" text,
	"signal_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_signal_opportunity" UNIQUE("run_id","opportunity_key"),
	CONSTRAINT "strategy_candidate_id" UNIQUE("signal_id"),
	CONSTRAINT "strategy_fixture_candidates_only" CHECK ("strategy_decisions"."outcome" != 'BUY_CANDIDATE' OR ("strategy_decisions"."mode" = 'FIXTURE' AND "strategy_decisions"."opportunity_key" IS NOT NULL AND "strategy_decisions"."signal_id" IS NOT NULL AND "strategy_decisions"."payload"->'candidate' IS NOT NULL AND "strategy_decisions"."payload"->'candidate' != 'null'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "strategy_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" "strategy_mode" NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"config_hash" text NOT NULL,
	"risk_policy_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"dataset_hash" text,
	"dataset" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_runs_id_mode" UNIQUE("id","mode")
);
--> statement-breakpoint
ALTER TABLE "market_candles" ADD CONSTRAINT "market_candles_run_id_strategy_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."strategy_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_corrections" ADD CONSTRAINT "market_corrections_run_id_strategy_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."strategy_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_coverage_observations" ADD CONSTRAINT "market_coverage_observations_run_id_strategy_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."strategy_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_trade_observations" ADD CONSTRAINT "market_trade_observations_run_id_strategy_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."strategy_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_run_id_mode_strategy_runs_id_mode_fk" FOREIGN KEY ("run_id","mode") REFERENCES "public"."strategy_runs"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_decisions" ADD CONSTRAINT "strategy_decisions_run_id_candle_id_market_candles_run_id_id_fk" FOREIGN KEY ("run_id","candle_id") REFERENCES "public"."market_candles"("run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_candle_token_time_idx" ON "market_candles" USING btree ("token_mint","end_time");--> statement-breakpoint
CREATE INDEX "market_correction_time_idx" ON "market_corrections" USING btree ("token_mint","received_at");--> statement-breakpoint
CREATE INDEX "market_coverage_token_time_idx" ON "market_coverage_observations" USING btree ("token_mint","start");--> statement-breakpoint
CREATE INDEX "market_trade_token_time_idx" ON "market_trade_observations" USING btree ("token_mint","timestamp");--> statement-breakpoint
CREATE INDEX "strategy_decision_token_time_idx" ON "strategy_decisions" USING btree ("token_mint","timestamp");--> statement-breakpoint
CREATE INDEX "strategy_decision_outcome_idx" ON "strategy_decisions" USING btree ("outcome","timestamp");