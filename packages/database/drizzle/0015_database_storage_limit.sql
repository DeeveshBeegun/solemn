CREATE TABLE public.solemn_storage_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  limit_bytes bigint NOT NULL DEFAULT 5000000000 CHECK (limit_bytes > 0 AND limit_bytes <= 5000000000),
  target_bytes bigint NOT NULL DEFAULT 4500000000 CHECK (target_bytes > 0 AND target_bytes < limit_bytes),
  cleanup_active boolean NOT NULL DEFAULT false,
  pending_tables text[] NOT NULL DEFAULT '{}',
  deleted_rows bigint NOT NULL DEFAULT 0,
  last_cleanup_at timestamptz,
  last_status text NOT NULL DEFAULT 'BELOW_LIMIT'
);
--> statement-breakpoint
INSERT INTO public.solemn_storage_policy (singleton) VALUES (true);
--> statement-breakpoint
-- Decimal 5 GB. This guards application writes against measured database size.
-- PostgreSQL WAL, temporary files and concurrent allocation require disk headroom.
CREATE FUNCTION public.solemn_database_storage_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  limit_bytes bigint;
  used_bytes bigint;
BEGIN
  SELECT p.limit_bytes INTO limit_bytes
  FROM public.solemn_storage_policy AS p WHERE singleton;

  IF limit_bytes IS NULL OR limit_bytes < 1 OR limit_bytes > 5000000000 THEN
    RAISE EXCEPTION 'Invalid Solemn database storage limit'
      USING ERRCODE = '22023';
  END IF;

  used_bytes := pg_database_size(current_database());
  IF used_bytes >= limit_bytes THEN
    RAISE EXCEPTION 'SOLEMN_DATABASE_STORAGE_LIMIT_REACHED'
      USING ERRCODE = '53100',
            DETAIL = format('Database usage %s bytes has reached the %s byte write limit.',
                            used_bytes, limit_bytes),
            HINT = 'Automatic retention will remove eligible old data. Review protected data if storage stays full.';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename <> 'solemn_storage_policy'
    ORDER BY tablename
  LOOP
    EXECUTE format(
      'CREATE TRIGGER solemn_storage_limit_before
       BEFORE INSERT OR UPDATE ON public.%I
       FOR EACH STATEMENT
       EXECUTE FUNCTION public.solemn_database_storage_guard()',
      relation.tablename
    );
    EXECUTE format(
      'CREATE TRIGGER solemn_storage_limit_after
       AFTER INSERT OR UPDATE ON public.%I
       FOR EACH STATEMENT
       EXECUTE FUNCTION public.solemn_database_storage_guard()',
      relation.tablename
    );
  END LOOP;
END;
$$;
