CREATE TABLE "backtest_scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"configuration" jsonb NOT NULL,
	CONSTRAINT "backtest_scenarios_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "backtest_scenario_experiment_name" UNIQUE("experiment_id","name")
);
--> statement-breakpoint
CREATE TABLE "execution_simulation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"model_version" text NOT NULL,
	"outcome" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "execution_simulation_attempts_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "backtest_scenarios" ADD CONSTRAINT "backtest_scenarios_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ADD CONSTRAINT "execution_simulation_attempts_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ADD CONSTRAINT "execution_simulation_attempts_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_simulation_attempts" ADD CONSTRAINT "execution_simulation_attempts_order_id_portfolio_id_orders_id_portfolio_id_fk" FOREIGN KEY ("order_id","portfolio_id") REFERENCES "public"."orders"("id","portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_attempts_run_idx" ON "execution_simulation_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE TRIGGER execution_attempt_immutable BEFORE UPDATE OR DELETE ON execution_simulation_attempts FOR EACH ROW EXECUTE FUNCTION solemn_backtest_result_immutable();
--> statement-breakpoint
CREATE TRIGGER backtest_scenario_immutable BEFORE UPDATE OR DELETE ON backtest_scenarios FOR EACH ROW EXECUTE FUNCTION solemn_backtest_result_immutable();
