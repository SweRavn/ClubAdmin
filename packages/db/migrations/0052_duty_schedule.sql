-- P2.6 part B (ADR 0050): shifts in "Mitt schema" and the calendar feeds,
-- the reminder the day before and the notices' category.

-- Notices about duties: reminders, assignments, swaps.
ALTER TABLE public.notifications DROP CONSTRAINT notifications_category;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category CHECK (category IN (
  'schedule', 'responses', 'leader', 'events', 'membership', 'club_admin', 'family', 'account',
  'waitlist', 'chat', 'documents', 'announcements', 'carpool', 'duties')) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_category;
--> statement-breakpoint

-- The reminder scan: a club's shifts by their start (the club's RLS context).
CREATE INDEX tasks_duty_starts_idx ON public.tasks (club_id, starts_at) WHERE kind = 'duty_shift';
--> statement-breakpoint

-- The caller's and their wards' shifts in a period across their clubs (each
-- read in turn, tenant RLS, as app.my_tasks): one row per assignment, by
-- the person index of task_assignments. The caller merges and sorts.
CREATE FUNCTION app.my_duty_shifts(p_from timestamptz, p_to timestamptz, p_limit integer)
  RETURNS TABLE (assignment_id uuid, shift_id uuid, club_id uuid, club_name text, time_zone text,
    group_id uuid, group_name text, title text, type_name text, starts_at timestamptz,
    ends_at timestamptz, location_name text, activity_id uuid, person_id uuid,
    counts_for_person_id uuid, status text, changed_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_people uuid[];
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_club uuid;
BEGIN
  IF app.current_person_id() IS NULL THEN
    RETURN;
  END IF;
  v_people := app.self_and_wards();
  FOREACH v_club IN ARRAY app.my_clubs_for(v_people) LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    RETURN QUERY
    SELECT a.id, t.id, t.club_id, cl.name, cl.time_zone, t.group_id, g.name, t.title, dt.name,
      t.starts_at, t.ends_at, l.name, t.source_activity_id, a.person_id, a.counts_for_person_id,
      a.status, greatest(t.updated_at, a.updated_at)
    FROM public.task_assignments a
    JOIN public.tasks t ON t.id = a.task_id AND t.kind = 'duty_shift'
    JOIN public.duty_types dt ON dt.id = t.duty_type_id
    JOIN public.clubs cl ON cl.id = t.club_id
    LEFT JOIN public.groups g ON g.id = t.group_id
    LEFT JOIN public.locations l ON l.id = t.location_id
    WHERE a.person_id = ANY (v_people) AND a.club_id = v_club
      AND t.starts_at < p_to AND t.ends_at > p_from
    ORDER BY t.starts_at, a.id
    LIMIT p_limit;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_duty_shifts(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_duty_shifts(timestamptz, timestamptz, integer) TO clubadmin_app;
