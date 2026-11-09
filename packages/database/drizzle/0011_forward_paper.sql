CREATE TABLE "forward_accounts" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"profile_hash" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"session_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"checkpoint" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forward_runtime_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_portfolios" DROP CONSTRAINT "paper_portfolio_modes";--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ADD COLUMN "forward_portfolio_id" uuid;--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD CONSTRAINT "forward_accounts_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_runtime_events" ADD CONSTRAINT "forward_runtime_events_portfolio_id_forward_accounts_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."forward_accounts"("portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forward_events_account_kind_time_idx" ON "forward_runtime_events" USING btree ("portfolio_id","kind","at");--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ADD CONSTRAINT "execution_simulation_attempts_forward_portfolio_id_forward_accounts_portfolio_id_fk" FOREIGN KEY ("forward_portfolio_id") REFERENCES "public"."forward_accounts"("portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_portfolios" ADD CONSTRAINT "paper_portfolio_modes" CHECK ("paper_portfolios"."mode" = 'PAPER' AND "paper_portfolios"."data_mode" IN ('FIXTURE','FORWARD_REPLAY','FORWARD_LIVE'));--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ADD CONSTRAINT "execution_attempt_scope" CHECK (("execution_simulation_attempts"."run_id" IS NOT NULL AND "execution_simulation_attempts"."forward_portfolio_id" IS NULL) OR ("execution_simulation_attempts"."run_id" IS NULL AND "execution_simulation_attempts"."forward_portfolio_id" IS NOT NULL AND "execution_simulation_attempts"."forward_portfolio_id" = "execution_simulation_attempts"."portfolio_id"));--> statement-breakpoint
CREATE TRIGGER forward_runtime_event_immutable BEFORE UPDATE OR DELETE ON forward_runtime_events FOR EACH ROW EXECUTE FUNCTION solemn_backtest_result_immutable();
