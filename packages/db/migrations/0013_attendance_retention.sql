ALTER TABLE "clubs" ADD COLUMN "attendance_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_attendance_retention_months" CHECK ("clubs"."attendance_retention_months" BETWEEN 12 AND 120);--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (#18, ADR 0035): retention of answers and attendance.
-------------------------------------------------------------------------------

-- Deletes the answers and attendance of the current club's activities that
-- ended more than the club's attendance_retention_months ago (at least 12).
-- The app roles may not delete attendance (it is corrected, never deleted);
-- this function, run by the worker's retention job, is the one way it goes.
-- Record history keeps the deleted rows until its own retention (ADR 0017).
CREATE FUNCTION app.purge_expired_attendance(OUT responses bigint, OUT attendance bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_club uuid := app.current_club_id();
  v_cutoff timestamptz;
BEGIN
  IF v_club IS NULL OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'system_job' THEN
    RAISE EXCEPTION 'purge_expired_attendance runs as a system job in a club'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT now() - make_interval(months => c.attendance_retention_months) INTO v_cutoff
  FROM public.clubs c WHERE c.id = v_club;

  -- starts_at first (activities_club_starts_idx); an activity ends after it starts.
  DELETE FROM public.activity_responses r
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND r.club_id = v_club AND r.activity_id = a.id;
  GET DIAGNOSTICS responses = ROW_COUNT;

  DELETE FROM public.attendance_records r
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND r.club_id = v_club AND r.activity_id = a.id;
  GET DIAGNOSTICS attendance = ROW_COUNT;
END
$$;

REVOKE ALL ON FUNCTION app.purge_expired_attendance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_attendance() TO clubadmin_app;
