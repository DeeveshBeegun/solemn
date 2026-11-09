CREATE TABLE "operational_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"actor" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text
);
--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD COLUMN "owner_pid" integer;--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD COLUMN "ops_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD COLUMN "ops_reason" text DEFAULT 'UNVERIFIED_PREVIOUS_STATE' NOT NULL;--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD COLUMN "ops_actor" text DEFAULT 'migration' NOT NULL;--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD COLUMN "ops_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD COLUMN "operational_health" jsonb;--> statement-breakpoint
ALTER TABLE "operational_audit_events" ADD CONSTRAINT "operational_audit_events_portfolio_id_forward_accounts_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."forward_accounts"("portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_portfolio_id_forward_accounts_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."forward_accounts"("portfolio_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operational_audit_account_time_idx" ON "operational_audit_events" USING btree ("portfolio_id","at");--> statement-breakpoint
CREATE INDEX "operational_incident_account_open_idx" ON "operational_incidents" USING btree ("portfolio_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_incident_active_category_idx" ON "operational_incidents" USING btree ("portfolio_id","category") WHERE "operational_incidents"."resolved_at" is null;--> statement-breakpoint
UPDATE forward_accounts AS f
SET status = CASE
      WHEN f.status = 'HALTED' OR p.status = 'HALTED' THEN 'HALTED'
      WHEN f.paused OR f.status = 'PAUSED' THEN 'PAUSED'
      ELSE 'STOPPED'
    END,
    paused = f.status <> 'HALTED' AND p.status <> 'HALTED'
      AND (f.paused OR f.status = 'PAUSED')
FROM paper_portfolios AS p
WHERE p.id = f.portfolio_id;
--> statement-breakpoint
ALTER TABLE "forward_accounts" ADD CONSTRAINT "forward_operational_status_check" CHECK ("forward_accounts"."status" IN ('STARTING','RECOVERING','RUNNING','DEGRADED','PAUSED','HALTED','STOPPING','STOPPED') AND "forward_accounts"."paused" = ("forward_accounts"."status" = 'PAUSED'));
--> statement-breakpoint
CREATE TRIGGER operational_audit_immutable BEFORE UPDATE OR DELETE ON operational_audit_events
FOR EACH ROW EXECUTE FUNCTION solemn_backtest_result_immutable();
