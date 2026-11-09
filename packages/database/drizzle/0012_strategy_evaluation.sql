CREATE TABLE "strategy_evaluation_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"configuration_hash" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_evaluation_period_order" CHECK ("strategy_evaluation_periods"."start_at" < "strategy_evaluation_periods"."end_at" AND "strategy_evaluation_periods"."registered_at" < "strategy_evaluation_periods"."start_at")
);
--> statement-breakpoint
CREATE TABLE "strategy_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid,
	"period_id" uuid,
	"strategy_id" text NOT NULL,
	"strategy_version" text,
	"source" text NOT NULL,
	"configuration_hash" text,
	"input_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"report_version" text NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_evaluation_periods" ADD CONSTRAINT "strategy_evaluation_periods_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_period_id_strategy_evaluation_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."strategy_evaluation_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategy_evaluation_period_strategy_idx" ON "strategy_evaluation_periods" USING btree ("strategy_id","start_at","end_at");--> statement-breakpoint
CREATE INDEX "strategy_evaluations_portfolio_time_idx" ON "strategy_evaluations" USING btree ("portfolio_id","start_at","end_at");--> statement-breakpoint
CREATE FUNCTION solemn_strategy_evaluation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Strategy evaluations and registered periods are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER strategy_evaluation_period_immutable BEFORE UPDATE OR DELETE ON strategy_evaluation_periods FOR EACH ROW EXECUTE FUNCTION solemn_strategy_evaluation_immutable();
--> statement-breakpoint
CREATE TRIGGER strategy_evaluation_immutable BEFORE UPDATE OR DELETE ON strategy_evaluations FOR EACH ROW EXECUTE FUNCTION solemn_strategy_evaluation_immutable();
