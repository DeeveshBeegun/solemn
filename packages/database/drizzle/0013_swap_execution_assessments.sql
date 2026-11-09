CREATE TABLE "swap_execution_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid,
	"signal_id" uuid,
	"quote_id" uuid,
	"input_mint" text NOT NULL,
	"output_mint" text NOT NULL,
	"input_amount" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swap_execution_assessments" ADD CONSTRAINT "swap_execution_assessments_portfolio_id_paper_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."paper_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swap_assessments_signal_idx" ON "swap_execution_assessments" USING btree ("portfolio_id","signal_id");--> statement-breakpoint
CREATE INDEX "swap_assessments_quote_idx" ON "swap_execution_assessments" USING btree ("quote_id");
--> statement-breakpoint
CREATE FUNCTION solemn_swap_execution_assessment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Swap execution assessments are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER swap_execution_assessment_immutable BEFORE UPDATE OR DELETE ON swap_execution_assessments FOR EACH ROW EXECUTE FUNCTION solemn_swap_execution_assessment_immutable();
