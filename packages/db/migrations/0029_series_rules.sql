-- Recurring series (P1.14, ADR 0034 amendment): a rule (a subset of RFC 5545
-- RRULE) instead of weekly slots only; series without an end date ("until
-- further notice"), materialised a horizon ahead and extended daily; the
-- answer request before each session at a chosen time.
--
-- Expand only: `slots` stays (weekly rules still take their days from it) and
-- existing series become weekly rules materialised to their end.

ALTER TABLE public.activity_series
  ADD COLUMN rule jsonb NOT NULL DEFAULT '{"freq": "weekly", "interval": 1}'::jsonb,
  ADD COLUMN request_lead jsonb,
  ADD COLUMN materialized_until date;
--> statement-breakpoint
-- The owner is subject to the forced row-level security like everyone else;
-- it is lifted for this statement of the migration's own transaction only.
ALTER TABLE public.activity_series NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE public.activity_series SET materialized_until = ends_on WHERE materialized_until IS NULL;
--> statement-breakpoint
ALTER TABLE public.activity_series FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.activity_series
  -- expand-contract: backfilled above in this transaction; the trigger below fills rows older code writes
  ALTER COLUMN materialized_until SET NOT NULL,
  ALTER COLUMN ends_on DROP NOT NULL,
  DROP CONSTRAINT activity_series_length,
  ADD CONSTRAINT activity_series_rule CHECK (rule->>'freq' IN ('daily', 'weekly', 'monthly')),
  ADD CONSTRAINT activity_series_request_lead
    CHECK (request_lead IS NULL OR request_lead->>'kind' IN ('days', 'hours'));
--> statement-breakpoint
-- Writers from before this release name no horizon: the series' end (or its
-- first date) stands in, as the series were made to their end.
CREATE FUNCTION app.series_materialized_until() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.materialized_until := coalesce(NEW.materialized_until, NEW.ends_on, NEW.starts_on);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER activity_series_materialized_until BEFORE INSERT ON public.activity_series
  FOR EACH ROW EXECUTE FUNCTION app.series_materialized_until();
--> statement-breakpoint
-- The daily extension finds open-ended (or long) series behind the horizon.
CREATE INDEX activity_series_extend_idx ON public.activity_series (materialized_until)
  WHERE ends_on IS NULL OR ends_on > materialized_until;
--> statement-breakpoint
-- The daily job finds them across clubs as the system (then works club by club).
CREATE POLICY system_read ON public.activity_series FOR SELECT USING (app.is_system());
--> statement-breakpoint

ALTER TABLE public.activities
  ADD COLUMN request_lead jsonb,
  ADD COLUMN request_at timestamptz,
  ADD COLUMN requested_at timestamptz,
  ADD CONSTRAINT activities_request_lead
    CHECK (request_lead IS NULL OR request_lead->>'kind' IN ('days', 'hours'));
--> statement-breakpoint
-- The request job: unsent requests by their time (in each club, RLS).
CREATE INDEX activities_request_idx ON public.activities (club_id, request_at)
  WHERE requested_at IS NULL AND request_at IS NOT NULL AND status = 'scheduled';
