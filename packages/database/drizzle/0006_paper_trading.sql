CREATE TABLE "paper_portfolios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"data_mode" text NOT NULL,
	"strategy_run_id" uuid NOT NULL,
	"config_hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"available_cash_usd" numeric NOT NULL,
	"reserved_cash_usd" numeric NOT NULL,
	"equity_usd" numeric NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"last_event_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "paper_portfolio_modes" CHECK ("paper_portfolios"."mode" = 'PAPER' AND "paper_portfolios"."data_mode" = 'FIXTURE'),
	CONSTRAINT "paper_portfolio_cash" CHECK ("paper_portfolios"."available_cash_usd" >= 0 AND "paper_portfolios"."reserved_cash_usd" >= 0 AND "paper_portfolios"."equity_usd" >= 0 AND scale("paper_portfolios"."available_cash_usd") <= 18 AND scale("paper_portfolios"."reserved_cash_usd") <= 18 AND scale("paper_portfolios"."equity_usd") <= 18 AND "paper_portfolios"."available_cash_usd" < 1e60 AND "paper_portfolios"."reserved_cash_usd" < 1e60 AND "paper_portfolios"."equity_usd" < 1e60),
	CONSTRAINT "paper_portfolio_snapshot" CHECK ("paper_portfolios"."available_cash_usd" = ("paper_portfolios"."state"->>'availableCashUsd')::numeric AND "paper_portfolios"."reserved_cash_usd" = ("paper_portfolios"."state"->>'reservedCashUsd')::numeric AND "paper_portfolios"."equity_usd" = ("paper_portfolios"."state"->>'equityUsd')::numeric AND "paper_portfolios"."status" = "paper_portfolios"."state"->>'status' AND "paper_portfolios"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "portfolio_balance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"command" jsonb,
	"input_hash" text NOT NULL,
	"postings" jsonb NOT NULL,
	"orders" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"state_after" jsonb NOT NULL,
	"previous_hash" text,
	"event_hash" text NOT NULL,
	CONSTRAINT "paper_ledger_sequence" UNIQUE("portfolio_id","sequence"),
	CONSTRAINT "paper_ledger_positive_sequence" CHECK ("portfolio_balance_events"."sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "portfolio_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paper_position_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "strategy_candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paper_details" jsonb;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "portfolio_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "pool_address" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "paper_state" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "paper_details" jsonb;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "portfolio_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "position_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "notional_usd" numeric;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_id_portfolio" UNIQUE("id","portfolio_id");--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_id_portfolio" UNIQUE("id","portfolio_id");--> statement-breakpoint
ALTER TABLE "paper_portfolios" ADD CONSTRAINT "paper_portfolios_strategy_run_id_strategy_runs_id_fk" FOREIGN KEY ("strategy_run_id") REFERENCES "public"."strategy_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_balance_events" ADD CONSTRAINT "portfolio_balance_events_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_portfolio_status_idx" ON "paper_portfolios" USING btree ("status");--> statement-breakpoint
CREATE INDEX "paper_ledger_time_idx" ON "portfolio_balance_events" USING btree ("portfolio_id","timestamp");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_paper_position_id_positions_id_fk" FOREIGN KEY ("paper_position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_strategy_candidate_id_strategy_decisions_signal_id_fk" FOREIGN KEY ("strategy_candidate_id") REFERENCES "public"."strategy_decisions"("signal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_paper_position_id_portfolio_id_positions_id_portfolio_id_fk" FOREIGN KEY ("paper_position_id","portfolio_id") REFERENCES "public"."positions"("id","portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_order_id_portfolio_id_orders_id_portfolio_id_fk" FOREIGN KEY ("order_id","portfolio_id") REFERENCES "public"."orders"("id","portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_portfolio_id_positions_id_portfolio_id_fk" FOREIGN KEY ("position_id","portfolio_id") REFERENCES "public"."positions"("id","portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_entry_signal_unique" ON "orders" USING btree ("portfolio_id","strategy_candidate_id") WHERE "orders"."portfolio_id" IS NOT NULL AND "orders"."side" = 'BUY';--> statement-breakpoint
CREATE UNIQUE INDEX "paper_one_active_position" ON "positions" USING btree ("portfolio_id","token_mint") WHERE "positions"."portfolio_id" IS NOT NULL AND "positions"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "paper_one_fill_per_order" ON "trades" USING btree ("order_id") WHERE "trades"."portfolio_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "paper_orders_terminal" CHECK ("orders"."portfolio_id" IS NULL OR ("orders"."status" IN ('FILLED', 'FAILED', 'CANCELLED') AND "orders"."paper_details" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "paper_position_state" CHECK ("positions"."portfolio_id" IS NULL OR ("positions"."paper_details" IS NOT NULL AND "positions"."pool_address" IS NOT NULL AND "positions"."paper_state" IN ('OPEN', 'CLOSED', 'EXIT_BLOCKED') AND ("positions"."paper_details"->>'quantity')::numeric = "positions"."quantity" AND ("positions"."paper_details"->>'costBasisUsd')::numeric = "positions"."cost_basis_usd" AND "positions"."paper_details"->>'status' = "positions"."paper_state"));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "paper_fill_metadata" CHECK ("trades"."portfolio_id" IS NULL OR ("trades"."position_id" IS NOT NULL AND "trades"."notional_usd" IS NOT NULL AND "trades"."notional_usd" > 0 AND scale("trades"."notional_usd") <= 18 AND "trades"."notional_usd" < 1e60));--> statement-breakpoint
-- Financial journals are append-only; corrections require a new command/event.
CREATE FUNCTION solemn_paper_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Paper ledger events are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_ledger_immutable BEFORE UPDATE OR DELETE ON portfolio_balance_events FOR EACH ROW EXECUTE FUNCTION solemn_paper_ledger_immutable();
--> statement-breakpoint
-- Deferred checks allow order, fill and ledger to be written in one atomic transaction.
CREATE FUNCTION solemn_paper_fill_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_order orders%ROWTYPE; target_id uuid; fill_count bigint; filled_quantity numeric; filled_fees numeric;
BEGIN
  IF TG_TABLE_NAME = 'trades' THEN target_id := NEW.order_id; ELSE target_id := NEW.id; END IF;
  SELECT * INTO selected_order FROM orders WHERE id = target_id;
  IF selected_order.portfolio_id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(executed_quantity),0), coalesce(sum(fees_usd),0) INTO fill_count, filled_quantity, filled_fees FROM trades WHERE order_id = target_id;
  IF selected_order.status = 'FILLED' THEN
    IF fill_count != 1 OR filled_quantity != selected_order.requested_quantity OR filled_fees != selected_order.actual_fees_usd THEN
      RAISE EXCEPTION 'Paper FILLED order requires one matching full fill' USING ERRCODE = '23514';
    END IF;
  ELSIF fill_count != 0 THEN
    RAISE EXCEPTION 'Non-filled paper order cannot own a fill' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM portfolio_balance_events e WHERE e.portfolio_id = selected_order.portfolio_id AND e.orders @> jsonb_build_array(jsonb_build_object('order', jsonb_build_object('id', target_id::text)))) THEN
    RAISE EXCEPTION 'Paper order requires its immutable ledger event' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_order_fill_consistency AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION solemn_paper_fill_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_trade_order_consistency AFTER INSERT OR UPDATE ON trades DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION solemn_paper_fill_consistency();
--> statement-breakpoint
CREATE FUNCTION solemn_paper_portfolio_journal_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest portfolio_balance_events%ROWTYPE; cash numeric; reserved numeric;
BEGIN
  -- Query the final row: one transaction may process multiple observations.
  SELECT * INTO NEW FROM paper_portfolios WHERE id = NEW.id;
  SELECT * INTO latest FROM portfolio_balance_events WHERE portfolio_id = NEW.id ORDER BY sequence DESC LIMIT 1;
  IF latest.id IS NULL OR latest.sequence != NEW.version OR latest.state_after != NEW.state OR latest.event_hash != NEW.last_event_hash THEN
    RAISE EXCEPTION 'Paper portfolio must match its latest ledger event' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum((p->>'availableDeltaUsd')::numeric),0), coalesce(sum((p->>'reservedDeltaUsd')::numeric),0) INTO cash, reserved FROM portfolio_balance_events e CROSS JOIN LATERAL jsonb_array_elements(e.postings) p WHERE e.portfolio_id = NEW.id;
  IF cash != NEW.available_cash_usd OR reserved != NEW.reserved_cash_usd THEN
    RAISE EXCEPTION 'Paper cash must reconcile with ledger postings' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_portfolio_journal_consistency AFTER INSERT OR UPDATE ON paper_portfolios DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION solemn_paper_portfolio_journal_consistency();
