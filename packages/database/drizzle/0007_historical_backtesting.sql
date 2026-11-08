CREATE TABLE "backtest_dataset_events" (
	"dataset_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"sort_key" text NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"event_at" timestamp with time zone,
	"kind" text NOT NULL,
	"mint" text NOT NULL,
	"pool_address" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	CONSTRAINT "backtest_dataset_events_dataset_id_id_pk" PRIMARY KEY("dataset_id","id"),
	CONSTRAINT "backtest_dataset_sort_key" UNIQUE("dataset_id","sort_key")
);
--> statement-breakpoint
CREATE TABLE "backtest_datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"fingerprint" text,
	"manifest" jsonb NOT NULL,
	"quality" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backtest_dataset_source_version" UNIQUE("source_id","version"),
	CONSTRAINT "backtest_dataset_state" CHECK ("backtest_datasets"."status" IN ('IMPORTING', 'READY') AND ("backtest_datasets"."status" != 'READY' OR ("backtest_datasets"."fingerprint" IS NOT NULL AND "backtest_datasets"."quality" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "backtest_equity_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"available_cash_usd" numeric NOT NULL,
	"reserved_cash_usd" numeric NOT NULL,
	"marked_positions_usd" numeric,
	"total_equity_usd" numeric,
	"realized_pnl_usd" numeric NOT NULL,
	"unrealized_pnl_usd" numeric,
	"drawdown_percent" numeric,
	"valuation_quality" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "backtest_equity_time" UNIQUE("run_id","timestamp"),
	CONSTRAINT "backtest_equity_quality" CHECK (("backtest_equity_snapshots"."valuation_quality" = 'RELIABLE' AND "backtest_equity_snapshots"."total_equity_usd" IS NOT NULL AND "backtest_equity_snapshots"."marked_positions_usd" IS NOT NULL AND "backtest_equity_snapshots"."unrealized_pnl_usd" IS NOT NULL AND "backtest_equity_snapshots"."drawdown_percent" IS NOT NULL) OR ("backtest_equity_snapshots"."valuation_quality" = 'UNCERTAIN' AND "backtest_equity_snapshots"."total_equity_usd" IS NULL AND "backtest_equity_snapshots"."marked_positions_usd" IS NULL AND "backtest_equity_snapshots"."unrealized_pnl_usd" IS NULL AND "backtest_equity_snapshots"."drawdown_percent" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "backtest_execution_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_results" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"dataset_fingerprint" text NOT NULL,
	"portfolio_id" uuid,
	"strategy_run_id" uuid,
	"config_hash" text NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "backtest_runs_portfolio_id_unique" UNIQUE("portfolio_id"),
	CONSTRAINT "backtest_runs_strategy_run_id_unique" UNIQUE("strategy_run_id"),
	CONSTRAINT "backtest_run_status" CHECK ("backtest_runs"."status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "backtest_dataset_events" ADD CONSTRAINT "backtest_dataset_events_dataset_id_backtest_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."backtest_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_equity_snapshots" ADD CONSTRAINT "backtest_equity_snapshots_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_execution_intents" ADD CONSTRAINT "backtest_execution_intents_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_dataset_id_backtest_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."backtest_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_run_id_strategy_runs_id_fk" FOREIGN KEY ("strategy_run_id") REFERENCES "public"."strategy_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_dataset_availability_idx" ON "backtest_dataset_events" USING btree ("dataset_id","available_at");--> statement-breakpoint
CREATE INDEX "backtest_equity_run_time_idx" ON "backtest_equity_snapshots" USING btree ("run_id","timestamp");--> statement-breakpoint
CREATE INDEX "backtest_intents_run_status_idx" ON "backtest_execution_intents" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "backtest_run_dataset_idx" ON "backtest_runs" USING btree ("dataset_id","created_at");--> statement-breakpoint
-- Published dataset versions are immutable. Import transactions write only before READY.
CREATE FUNCTION solemn_backtest_dataset_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
  IF TG_TABLE_NAME = 'backtest_datasets' THEN
    IF OLD.status = 'READY' THEN RAISE EXCEPTION 'Published backtest datasets are immutable' USING ERRCODE = '23514'; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN SELECT status INTO state FROM backtest_datasets WHERE id=OLD.dataset_id;
    ELSE SELECT status INTO state FROM backtest_datasets WHERE id=NEW.dataset_id; END IF;
    IF state = 'READY' THEN RAISE EXCEPTION 'Published historical events are immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER backtest_dataset_immutable BEFORE UPDATE OR DELETE ON backtest_datasets FOR EACH ROW EXECUTE FUNCTION solemn_backtest_dataset_immutable();
--> statement-breakpoint
CREATE TRIGGER backtest_event_immutable BEFORE INSERT OR UPDATE OR DELETE ON backtest_dataset_events FOR EACH ROW EXECUTE FUNCTION solemn_backtest_dataset_immutable();
--> statement-breakpoint
CREATE FUNCTION solemn_backtest_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Backtest results and equity snapshots are immutable' USING ERRCODE = '23514'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER backtest_result_immutable BEFORE UPDATE OR DELETE ON backtest_results FOR EACH ROW EXECUTE FUNCTION solemn_backtest_result_immutable();
--> statement-breakpoint
CREATE TRIGGER backtest_equity_immutable BEFORE UPDATE OR DELETE ON backtest_equity_snapshots FOR EACH ROW EXECUTE FUNCTION solemn_backtest_result_immutable();
