-- Custom SQL migration file, put your migrations below! --
-- Request budgets (ADR 0040): the "insider" read policies asked
-- app.has_club_relationship(club_id) for every row, four or five index
-- lookups each (about nine pages a row), so a plan that touched a few dozen
-- rows read hundreds of pages. The same answer as one array per statement:
-- app.related_club_ids() runs once (an InitPlan, being wrapped in a scalar
-- subquery) and each row is a membership test in memory. Same rules as
-- has_club_relationship (memberships of the person and their wards, roles,
-- current employment, open support grants), read with the caller's own
-- row-level security as before.
CREATE FUNCTION app.related_club_ids() RETURNS uuid[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE WHEN app.current_person_id() IS NULL THEN '{}'::uuid[] ELSE ARRAY(
    SELECT m.club_id FROM public.club_memberships m
    WHERE m.person_id = ANY (app.self_and_wards()) AND m.valid_to IS NULL
      AND m.status IN ('active', 'paused')
    UNION
    SELECT r.club_id FROM public.club_role_assignments r
    WHERE r.person_id = app.current_person_id() AND r.valid_to IS NULL
    UNION
    SELECT e.club_id FROM public.employments e
    WHERE e.person_id = app.current_person_id()
      AND e.starts_on <= current_date AND (e.ends_on IS NULL OR e.ends_on >= current_date)
    UNION
    SELECT s.club_id FROM public.support_access_grants s
    WHERE s.operator_person_id = app.current_person_id()
      AND s.revoked_at IS NULL AND s.expires_at > now()
  ) END
$$;
--> statement-breakpoint
ALTER POLICY insider_read ON public.clubs
  USING (id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.groups
  USING (club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.activity_series
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.activity_series_groups
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.activities
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.activity_groups
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.events
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.event_groups
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.event_activities
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY insider_read ON public.club_phone_numbers
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
