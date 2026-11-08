CREATE TABLE "token_risk_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"request_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"status" "risk_status" NOT NULL,
	"reasons" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_risk_request_attempt_unique" UNIQUE("request_id","attempt"),
	CONSTRAINT "token_risk_attempt_positive" CHECK ("token_risk_assessments"."attempt" > 0),
	CONSTRAINT "token_risk_eligible_expiry" CHECK ("token_risk_assessments"."status" != 'ELIGIBLE' OR ("token_risk_assessments"."valid_until" IS NOT NULL AND "token_risk_assessments"."valid_until" > "token_risk_assessments"."assessed_at"))
);
--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_request_id" uuid;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_trigger" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_next_assessment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_assessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "risk_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "latest_risk_assessment_id" uuid;--> statement-breakpoint
ALTER TABLE "token_risk_assessments" ADD CONSTRAINT "token_risk_assessments_token_mint_tokens_mint_address_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_risk_history_idx" ON "token_risk_assessments" USING btree ("token_mint","assessed_at");--> statement-breakpoint
CREATE INDEX "token_risk_candidate_idx" ON "token_risk_assessments" USING btree ("status","valid_until");--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_latest_risk_assessment_id_token_risk_assessments_id_fk" FOREIGN KEY ("latest_risk_assessment_id") REFERENCES "public"."token_risk_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tokens_risk_work_idx" ON "tokens" USING btree ("risk_next_assessment_at","risk_lease_until");--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_risk_attempts_nonnegative" CHECK ("tokens"."risk_attempt_count" >= 0);