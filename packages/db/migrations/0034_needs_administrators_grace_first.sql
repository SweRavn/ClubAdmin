-- P1.15 A3: app.club_needs_administrators reads the club's grace period
-- before it counts the administrators. Every new membership asks it; a club
-- within its grace period (every existing club with one administrator, the
-- seed and the test clubs while they are built) then needs one indexed row
-- instead of the administrators' join.

CREATE OR REPLACE FUNCTION app.club_needs_administrators(p_club uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
  v_grace timestamptz;
  v_kind text := app.setting('app.actor_kind');
  v_club text := app.setting('app.club_id');
BEGIN
  IF NOT coalesce(app.is_system() OR p_club = app.current_club_id(), false) THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.club_id', p_club::text, true);
  SELECT administrators_grace_until INTO v_grace FROM public.clubs WHERE id = p_club;
  PERFORM set_config('app.actor_kind', coalesce(v_kind, ''), true);
  PERFORM set_config('app.club_id', coalesce(v_club, ''), true);
  IF v_grace IS NOT NULL AND v_grace > now() THEN
    RETURN false;
  END IF;
  SELECT count(*) FILTER (WHERE a.counts) INTO v_count FROM app.club_administrators(p_club) a;
  RETURN v_count < 2;
END
$$;
