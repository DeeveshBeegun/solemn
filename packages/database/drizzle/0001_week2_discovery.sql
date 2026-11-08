CREATE TYPE "public"."migration_status" AS ENUM('UNKNOWN', 'MIGRATED');--> statement-breakpoint
CREATE TABLE "scanner_gaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text NOT NULL,
	CONSTRAINT "scanner_gaps_valid_times" CHECK ("scanner_gaps"."ended_at" IS NULL OR "scanner_gaps"."ended_at" >= "scanner_gaps"."started_at")
);
--> statement-breakpoint
ALTER TABLE "market_events" ALTER COLUMN "event_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "symbol" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "decimals" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "created_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "market_events" ADD COLUMN "raw_message" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "creator_address" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "bonding_curve_address" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "migration_status" "migration_status" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "migrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "migration_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "migration_venue" text;--> statement-breakpoint
CREATE INDEX "scanner_gaps_source_time_idx" ON "scanner_gaps" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "tokens_migration_idx" ON "tokens" USING btree ("migration_status","migration_observed_at");