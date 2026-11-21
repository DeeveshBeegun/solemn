ALTER TYPE public.strategy_mode ADD VALUE IF NOT EXISTS 'LIVE_PAPER';
--> statement-breakpoint
ALTER TABLE strategy_decisions DROP CONSTRAINT strategy_fixture_candidates_only;
--> statement-breakpoint
ALTER TABLE strategy_decisions ADD CONSTRAINT strategy_fixture_candidates_only CHECK (
  outcome <> 'BUY_CANDIDATE' OR (
    opportunity_key IS NOT NULL AND signal_id IS NOT NULL AND payload->'candidate' IS NOT NULL
    AND ((mode::text='FIXTURE' AND coalesce(payload->'candidate'->>'dataMode','')='FIXTURE')
      OR (mode::text='LIVE_PAPER' AND coalesce(payload->'candidate'->>'dataMode','')='LIVE_PAPER'))
  )
);
