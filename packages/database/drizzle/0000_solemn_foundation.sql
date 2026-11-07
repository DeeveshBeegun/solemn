CREATE TYPE "public"."execution_mode" AS ENUM('PAPER', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('CREATED', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."risk_status" AS ENUM('UNKNOWN', 'ELIGIBLE', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('BUY', 'SELL', 'HOLD');--> statement-breakpoint
CREATE TABLE "market_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"event_type" text NOT NULL,
	"source_event_id" text NOT NULL,
	"slot" bigint,
	"transaction_signature" text,
	"event_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	CONSTRAINT "market_events_source_identity" UNIQUE("source","source_event_id"),
	CONSTRAINT "market_events_slot_nonnegative" CHECK ("market_events"."slot" IS NULL OR "market_events"."slot" >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"price_usd" numeric NOT NULL,
	"pool_liquidity_usd" numeric NOT NULL,
	"volume_usd" numeric NOT NULL,
	"buy_volume_usd" numeric NOT NULL,
	"sell_volume_usd" numeric NOT NULL,
	"unique_buyer_count" integer NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"max_age_ms" integer NOT NULL,
	"volume_window_seconds" integer NOT NULL,
	CONSTRAINT "market_snapshots_id_token" UNIQUE("id","token_mint"),
	CONSTRAINT "market_snapshots_valid_amounts" CHECK ("market_snapshots"."price_usd" > 0 AND "market_snapshots"."pool_liquidity_usd" >= 0 AND "market_snapshots"."volume_usd" >= 0 AND "market_snapshots"."buy_volume_usd" >= 0 AND "market_snapshots"."sell_volume_usd" >= 0),
	CONSTRAINT "market_snapshots_freshness" CHECK ("market_snapshots"."unique_buyer_count" >= 0 AND "market_snapshots"."max_age_ms" >= 0 AND "market_snapshots"."volume_window_seconds" > 0),
	CONSTRAINT "market_snapshots_precision" CHECK ((scale("market_snapshots"."price_usd") <= 18 AND abs("market_snapshots"."price_usd") < 1e60::numeric) AND (scale("market_snapshots"."pool_liquidity_usd") <= 18 AND abs("market_snapshots"."pool_liquidity_usd") < 1e60::numeric) AND (scale("market_snapshots"."volume_usd") <= 18 AND abs("market_snapshots"."volume_usd") < 1e60::numeric) AND (scale("market_snapshots"."buy_volume_usd") <= 18 AND abs("market_snapshots"."buy_volume_usd") < 1e60::numeric) AND (scale("market_snapshots"."sell_volume_usd") <= 18 AND abs("market_snapshots"."sell_volume_usd") < 1e60::numeric))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"side" "order_side" NOT NULL,
	"execution_mode" "execution_mode" DEFAULT 'PAPER' NOT NULL,
	"requested_quantity" numeric NOT NULL,
	"status" "order_status" DEFAULT 'CREATED' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"estimated_fees_usd" numeric NOT NULL,
	"actual_fees_usd" numeric,
	CONSTRAINT "orders_id_token_side" UNIQUE("id","token_mint","side"),
	CONSTRAINT "orders_paper_only" CHECK ("orders"."execution_mode" = 'PAPER'),
	CONSTRAINT "orders_valid_amounts" CHECK ("orders"."requested_quantity" > 0 AND "orders"."estimated_fees_usd" >= 0 AND ("orders"."actual_fees_usd" IS NULL OR "orders"."actual_fees_usd" >= 0)),
	CONSTRAINT "orders_precision" CHECK ((scale("orders"."requested_quantity") <= 18 AND abs("orders"."requested_quantity") < 1e60::numeric) AND (scale("orders"."estimated_fees_usd") <= 18 AND abs("orders"."estimated_fees_usd") < 1e60::numeric) AND (scale("orders"."actual_fees_usd") <= 18 AND abs("orders"."actual_fees_usd") < 1e60::numeric)),
	CONSTRAINT "orders_valid_times" CHECK (("orders"."submitted_at" IS NULL OR "orders"."submitted_at" >= "orders"."created_at") AND ("orders"."executed_at" IS NULL OR ("orders"."submitted_at" IS NOT NULL AND "orders"."executed_at" >= "orders"."submitted_at"))),
	CONSTRAINT "orders_lifecycle" CHECK (("orders"."status" != 'CREATED' OR ("orders"."submitted_at" IS NULL AND "orders"."executed_at" IS NULL AND "orders"."actual_fees_usd" IS NULL)) AND ("orders"."status" NOT IN ('SUBMITTED', 'PARTIALLY_FILLED', 'FILLED') OR "orders"."submitted_at" IS NOT NULL) AND ("orders"."status" NOT IN ('PARTIALLY_FILLED', 'FILLED') OR ("orders"."executed_at" IS NOT NULL AND "orders"."actual_fees_usd" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"quantity" numeric NOT NULL,
	"average_entry_price_usd" numeric NOT NULL,
	"cost_basis_usd" numeric NOT NULL,
	"realized_pnl_usd" numeric NOT NULL,
	"unrealized_pnl_usd" numeric NOT NULL,
	"status" "position_status" NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "positions_valid_amounts" CHECK ("positions"."quantity" >= 0 AND "positions"."average_entry_price_usd" > 0 AND "positions"."cost_basis_usd" >= 0),
	CONSTRAINT "positions_precision" CHECK ((scale("positions"."quantity") <= 18 AND abs("positions"."quantity") < 1e60::numeric) AND (scale("positions"."average_entry_price_usd") <= 18 AND abs("positions"."average_entry_price_usd") < 1e60::numeric) AND (scale("positions"."cost_basis_usd") <= 18 AND abs("positions"."cost_basis_usd") < 1e60::numeric) AND (scale("positions"."realized_pnl_usd") <= 18 AND abs("positions"."realized_pnl_usd") < 1e60::numeric) AND (scale("positions"."unrealized_pnl_usd") <= 18 AND abs("positions"."unrealized_pnl_usd") < 1e60::numeric)),
	CONSTRAINT "positions_lifecycle" CHECK (("positions"."status" = 'OPEN' AND "positions"."quantity" > 0 AND "positions"."closed_at" IS NULL) OR ("positions"."status" = 'CLOSED' AND "positions"."quantity" = 0 AND "positions"."closed_at" >= "positions"."opened_at" AND "positions"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"mint_address" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"source_platform" text NOT NULL,
	"pool_address" text,
	"risk_status" "risk_status" DEFAULT 'UNKNOWN' NOT NULL,
	CONSTRAINT "tokens_decimals_range" CHECK ("tokens"."decimals" BETWEEN 0 AND 255)
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"token_mint" text NOT NULL,
	"side" "order_side" NOT NULL,
	"executed_quantity" numeric NOT NULL,
	"execution_price_usd" numeric NOT NULL,
	"fees_usd" numeric NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "trades_valid_amounts" CHECK ("trades"."executed_quantity" > 0 AND "trades"."execution_price_usd" > 0 AND "trades"."fees_usd" >= 0),
	CONSTRAINT "trades_precision" CHECK ((scale("trades"."executed_quantity") <= 18 AND abs("trades"."executed_quantity") < 1e60::numeric) AND (scale("trades"."execution_price_usd") <= 18 AND abs("trades"."execution_price_usd") < 1e60::numeric) AND (scale("trades"."fees_usd") <= 18 AND abs("trades"."fees_usd") < 1e60::numeric))
);
--> statement-breakpoint
CREATE TABLE "trading_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"signal_type" "signal_type" NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"explanation" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"risk_assessment" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_order_id_token_mint_side_orders_id_token_mint_side_fk" FOREIGN KEY ("order_id","token_mint","side") REFERENCES "public"."orders"("id","token_mint","side") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_signals" ADD CONSTRAINT "trading_signals_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_signals" ADD CONSTRAINT "trading_signals_snapshot_id_token_mint_market_snapshots_id_token_mint_fk" FOREIGN KEY ("snapshot_id","token_mint") REFERENCES "public"."market_snapshots"("id","token_mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_events_token_time_idx" ON "market_events" USING btree ("token_mint","event_at");--> statement-breakpoint
CREATE INDEX "market_events_signature_idx" ON "market_events" USING btree ("transaction_signature");--> statement-breakpoint
CREATE INDEX "market_snapshots_token_time_idx" ON "market_snapshots" USING btree ("token_mint","timestamp");--> statement-breakpoint
CREATE INDEX "orders_token_time_idx" ON "orders" USING btree ("token_mint","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "positions_token_status_idx" ON "positions" USING btree ("token_mint","status");--> statement-breakpoint
CREATE INDEX "tokens_discovered_at_idx" ON "tokens" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "trades_order_idx" ON "trades" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "trades_token_time_idx" ON "trades" USING btree ("token_mint","timestamp");--> statement-breakpoint
CREATE INDEX "trading_signals_token_time_idx" ON "trading_signals" USING btree ("token_mint","timestamp");--> statement-breakpoint
CREATE INDEX "trading_signals_snapshot_idx" ON "trading_signals" USING btree ("snapshot_id");