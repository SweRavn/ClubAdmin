-- P2.10 (ADR 0056 and its amendment of 2026-11-28): call-ups across groups,
-- for series, and revoking a call-up.
-- - Guest roles: `roles.guest` and `club_type_roles.guest`; the template
--   group role `guest_player` (group.participate only) in every club type
--   and every club. Guests take part but take no places (app.group_places),
--   and are in the group's default channel only with
--   `groups.guests_in_channel`.
-- - A series' call-up (`activity_series.invitees_only`,
--   `activity_series_invitees`) and per-session overrides
--   (`activity_invitee_overrides`); `activity_invitees` stays the read model.
-- - Revoked call-ups with their reason (`activity_callup_revocations`):
--   personal data, shown to the person, their guardians and the leaders;
--   deleted with the attendance retention and on erasure.

ALTER TABLE public.roles ADD COLUMN guest boolean NOT NULL DEFAULT false;
ALTER TABLE public.club_type_roles ADD COLUMN guest boolean NOT NULL DEFAULT false;
ALTER TABLE public.groups ADD COLUMN guests_in_channel boolean NOT NULL DEFAULT false;
-- A guest membership (its role is a guest role), kept by the role trigger as
-- `participates` is, so that places, rosters and channels read no roles.
ALTER TABLE public.group_memberships ADD COLUMN guest boolean NOT NULL DEFAULT false;
ALTER TABLE public.activity_series ADD COLUMN invitees_only boolean NOT NULL DEFAULT false;

CREATE TABLE public.activity_series_invitees (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  series_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  added_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT activity_series_invitees_unique UNIQUE (series_id, person_id),
  CONSTRAINT activity_series_invitees_series_fk FOREIGN KEY (club_id, series_id)
    REFERENCES public.activity_series (club_id, id) ON DELETE CASCADE
);
CREATE INDEX activity_series_invitees_person_idx ON public.activity_series_invitees (person_id);
CREATE INDEX activity_series_invitees_adder_idx ON public.activity_series_invitees (added_by_person_id);

CREATE TABLE public.activity_invitee_overrides (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  activity_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  kind text NOT NULL CONSTRAINT activity_invitee_overrides_kind CHECK (kind IN ('added', 'removed')),
  set_by_person_id uuid REFERENCES public.people(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT activity_invitee_overrides_unique UNIQUE (activity_id, person_id),
  CONSTRAINT activity_invitee_overrides_activity_fk FOREIGN KEY (club_id, activity_id)
    REFERENCES public.activities (club_id, id) ON DELETE CASCADE
);
CREATE INDEX activity_invitee_overrides_person_idx ON public.activity_invitee_overrides (person_id);
CREATE INDEX activity_invitee_overrides_setter_idx ON public.activity_invitee_overrides (set_by_person_id);

CREATE TABLE public.activity_callup_revocations (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  activity_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES public.people(id),
  -- Written by a leader about a child's participation: personal data.
  reason text NOT NULL CONSTRAINT activity_callup_revocations_reason CHECK (length(reason) BETWEEN 1 AND 500),
  revoked_by_person_id uuid REFERENCES public.people(id),
  revoked_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT activity_callup_revocations_unique UNIQUE (activity_id, person_id),
  CONSTRAINT activity_callup_revocations_activity_fk FOREIGN KEY (club_id, activity_id)
    REFERENCES public.activities (club_id, id) ON DELETE CASCADE
);
CREATE INDEX activity_callup_revocations_person_idx ON public.activity_callup_revocations (person_id, activity_id);
CREATE INDEX activity_callup_revocations_revoker_idx ON public.activity_callup_revocations (revoked_by_person_id);
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.activity_series_invitees'),
  app.enable_updated_at('public.activity_series_invitees'),
  history.enable_history('public.activity_series_invitees');
SELECT app.enable_tenant_rls('public.activity_invitee_overrides'),
  app.enable_updated_at('public.activity_invitee_overrides'),
  history.enable_history('public.activity_invitee_overrides');
SELECT app.enable_tenant_rls('public.activity_callup_revocations'),
  app.enable_updated_at('public.activity_callup_revocations'),
  history.enable_history('public.activity_callup_revocations');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activity_series_invitees,
  public.activity_invitee_overrides, public.activity_callup_revocations TO clubadmin_app;
GRANT SELECT, DELETE ON public.activity_series_invitees, public.activity_invitee_overrides,
  public.activity_callup_revocations TO clubadmin_retention;
-- "My schedule" and the activity read a person's own and their wards'
-- revocations across clubs (as activity_invitees' own_read).
CREATE POLICY own_read ON public.activity_callup_revocations FOR SELECT
  USING (person_id = ANY ((SELECT app.self_and_wards())::uuid[]));
-- "My schedule" across clubs: someone called up from another group (or whose
-- call-up was taken back) reads that activity's entries too.
CREATE POLICY callup_read ON public.schedule_entries FOR SELECT
  USING (EXISTS (
      SELECT 1 FROM public.activity_invitees i
      WHERE i.activity_id = schedule_entries.activity_id
        AND i.person_id = ANY ((SELECT app.self_and_wards())::uuid[]))
    OR EXISTS (
      SELECT 1 FROM public.activity_callup_revocations v
      WHERE v.activity_id = schedule_entries.activity_id
        AND v.person_id = ANY ((SELECT app.self_and_wards())::uuid[])));
--> statement-breakpoint

-- Whether a role is a guest role (IDs only; memberships without a role are not).
CREATE FUNCTION app.is_guest_role(p_role uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT r.guest FROM public.roles r WHERE r.id = p_role), false)
$$;
REVOKE ALL ON FUNCTION app.is_guest_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_guest_role(uuid) TO clubadmin_app;
--> statement-breakpoint

-- The role trigger of 0036 also sets `guest`.
CREATE OR REPLACE FUNCTION app.group_memberships_role() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role record;
BEGIN
  IF NEW.role_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.function IS DISTINCT FROM OLD.function
      AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id) THEN
    v_role := app.role_facts(NEW.club_id, 'group', NULL, NEW.function);
  ELSE
    v_role := app.role_facts(NEW.club_id, 'group', NEW.role_id, NULL);
    NEW.function := CASE
      WHEN v_role.template_key IN ('member', 'head_coach', 'assistant_coach', 'team_manager',
        'physio', 'other_leader') THEN v_role.template_key
      WHEN v_role.participates THEN 'member' ELSE 'other_leader' END;
  END IF;
  IF v_role.role_id IS NULL OR v_role.scope <> 'group' THEN
    RAISE EXCEPTION 'not a group role of the club' USING ERRCODE = '23514';
  END IF;
  NEW.role_id := v_role.role_id;
  NEW.participates := v_role.participates;
  NEW.leads := v_role.leads;
  NEW.guest := app.is_guest_role(v_role.role_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- A role that becomes (or stops being) a guest role: its memberships follow.
CREATE FUNCTION app.roles_guest_flag() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.group_memberships SET guest = NEW.guest
  WHERE club_id = NEW.club_id AND role_id = NEW.id AND guest <> NEW.guest;
  RETURN NULL;
END
$$;
CREATE TRIGGER roles_guest_flag AFTER UPDATE OF guest ON public.roles
  FOR EACH ROW WHEN (OLD.guest IS DISTINCT FROM NEW.guest)
  EXECUTE FUNCTION app.roles_guest_flag();
--> statement-breakpoint

-- The group's members as before, with the guest flag (appended).
CREATE OR REPLACE VIEW app.visible_group_members WITH (security_invoker = true, security_barrier = true) AS
SELECT gm.id, gm.club_id, gm.group_id, gm.person_id, gm.function, gm.valid_from,
       lower(p.family_name) || ' ' || lower(p.given_name) AS sort_name,
       lower(p.given_name) || ' ' || lower(p.family_name) AS sort_given_name,
       gm.guest
FROM public.group_memberships gm
JOIN public.people p ON p.id = gm.person_id
LEFT JOIN public.club_profiles cp ON cp.club_id = gm.club_id AND cp.person_id = gm.person_id
WHERE gm.valid_to IS NULL AND (
  app.viewer_privileged()
  OR NOT (p.protected_identity OR coalesce(cp.protected_identity_club, false))
  OR gm.person_id = ANY ((SELECT app.self_and_wards())::uuid[])
);
--> statement-breakpoint

-- Guests take no places (ADR 0056 decision 1, ADR 0043).
CREATE OR REPLACE FUNCTION app.group_places(p_group_id uuid)
 RETURNS TABLE(capacity integer, occupied integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce((
      SELECT gs.capacity FROM public.group_seasons gs
      JOIN public.seasons s ON s.id = gs.season_id
      WHERE gs.group_id = g.id
        AND s.starts_on <= (now() AT TIME ZONE c.time_zone)::date
        AND s.ends_on >= (now() AT TIME ZONE c.time_zone)::date
      ORDER BY s.starts_on DESC LIMIT 1), g.capacity),
    (SELECT count(*)::int FROM public.group_memberships gm
      WHERE gm.club_id = g.club_id AND gm.group_id = g.id AND gm.valid_to IS NULL
        AND gm.participates AND NOT gm.guest)
    + (SELECT count(*)::int FROM public.group_waitlist_entries w
      WHERE w.group_id = g.id AND w.status IN ('offered', 'accepted'))
  FROM public.groups g JOIN public.clubs c ON c.id = g.club_id
  WHERE g.id = p_group_id
$function$;
--> statement-breakpoint

-- A new club's roles copy the guest flag from the type's template.
CREATE OR REPLACE FUNCTION app.create_builtin_roles(p_club uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_previous text := app.setting('app.club_id');
  v_type uuid;
BEGIN
  SELECT club_type_id INTO v_type FROM public.clubs WHERE id = p_club;
  IF v_type IS NULL THEN
    v_type := (SELECT id FROM public.club_types WHERE key = 'sports_club');
  END IF;
  PERFORM set_config('app.club_id', p_club::text, true);
  INSERT INTO public.roles (club_id, scope, template_key, locked, names, descriptions, sort_order,
    background_check_category, guest)
  SELECT p_club, t.scope, t.key, t.locked, t.names, t.descriptions, t.sort_order,
    t.background_check_category, t.guest
  FROM public.club_type_roles t WHERE t.club_type_id = v_type
  ON CONFLICT (club_id, scope, template_key) WHERE template_key IS NOT NULL DO NOTHING;
  INSERT INTO public.role_permissions (club_id, role_id, permission)
  SELECT p_club, r.id, p.permission
  FROM public.club_type_roles t
  JOIN public.club_type_role_permissions p ON p.club_type_role_id = t.id
  JOIN public.roles r ON r.club_id = p_club AND r.scope = t.scope AND r.template_key = t.key
  WHERE t.club_type_id = v_type
  ON CONFLICT (role_id, permission) DO NOTHING;
  PERFORM set_config('app.club_id', coalesce(v_previous, ''), true);
END
$$;
--> statement-breakpoint

-- The template group role "Gästspelare" in every club type and every club.
INSERT INTO public.club_type_roles (club_type_id, key, scope, names, locked, sort_order, guest)
SELECT t.id, 'guest_player', 'group',
  '{"sv": "Gästspelare", "en": "Guest player", "nb": "Gjestespiller"}'::jsonb, false,
  coalesce((SELECT max(r.sort_order) FROM public.club_type_roles r
    WHERE r.club_type_id = t.id AND r.scope = 'group'), 0) + 1, true
FROM public.club_types t
ON CONFLICT (club_type_id, scope, key) DO NOTHING;
INSERT INTO public.club_type_role_permissions (club_type_role_id, permission)
SELECT r.id, 'group.participate' FROM public.club_type_roles r WHERE r.key = 'guest_player'
ON CONFLICT (club_type_role_id, permission) DO NOTHING;

DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs ORDER BY id LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    INSERT INTO public.roles (club_id, scope, template_key, locked, names, sort_order, guest)
    SELECT v_club, 'group', 'guest_player', false,
      '{"sv": "Gästspelare", "en": "Guest player", "nb": "Gjestespiller"}'::jsonb,
      coalesce((SELECT max(r.sort_order) FROM public.roles r
        WHERE r.club_id = v_club AND r.scope = 'group'), 0) + 1, true
    ON CONFLICT (club_id, scope, template_key) WHERE template_key IS NOT NULL DO NOTHING;
    INSERT INTO public.role_permissions (club_id, role_id, permission)
    SELECT v_club, r.id, 'group.participate' FROM public.roles r
    WHERE r.club_id = v_club AND r.scope = 'group' AND r.template_key = 'guest_player'
    ON CONFLICT (role_id, permission) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- The group's default channel leaves out its guests unless its owners let
-- them in (groups.guests_in_channel).
CREATE OR REPLACE FUNCTION app.chat_sync_group(p_group uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_club uuid;
  v_name text;
  v_archived timestamptz;
  v_chat uuid;
  v_guests boolean;
BEGIN
  SELECT g.club_id, g.name, g.archived_at, g.guests_in_channel
  INTO v_club, v_name, v_archived, v_guests
  FROM public.groups g WHERE g.id = p_group;
  IF v_club IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.id INTO v_chat FROM public.chats c WHERE c.default_for_group_id = p_group;
  IF v_chat IS NULL THEN
    IF v_archived IS NOT NULL THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.chats (club_id, kind, name, visibility, default_for_group_id)
    VALUES (v_club, 'channel', left(v_name, 80), 'open', p_group)
    RETURNING id INTO v_chat;
    INSERT INTO public.chat_groups (club_id, chat_id, group_id) VALUES (v_club, v_chat, p_group);
  END IF;
  IF v_archived IS NOT NULL THEN
    UPDATE public.chats SET archived_at = coalesce(archived_at, now()) WHERE id = v_chat;
    RETURN v_chat;
  END IF;

  WITH people_now AS (
    SELECT DISTINCT gm.person_id,
      coalesce(p.protected_identity, false) OR coalesce(cp.protected_identity_club, false) AS prot
    FROM public.group_memberships gm
    JOIN public.people p ON p.id = gm.person_id
    LEFT JOIN public.club_profiles cp ON cp.club_id = v_club AND cp.person_id = gm.person_id
    WHERE gm.group_id = p_group AND gm.valid_to IS NULL
      AND (v_guests OR NOT gm.guest))
  INSERT INTO public.chat_members AS cm (club_id, chat_id, person_id, status, reason)
  SELECT v_club, v_chat, n.person_id, CASE WHEN n.prot THEN 'offered' ELSE 'active' END, 'group'
  FROM people_now n
  ON CONFLICT (chat_id, person_id) DO UPDATE
    SET status = excluded.status, reason = 'group', left_at = NULL, removed_by_person_id = NULL,
        joined_at = now()
  WHERE cm.status = 'left' AND cm.removed_by_person_id IS DISTINCT FROM cm.person_id;

  UPDATE public.chat_members cm SET status = 'left', left_at = now()
  WHERE cm.chat_id = v_chat AND cm.reason = 'group' AND cm.status <> 'left'
    AND NOT EXISTS (
      SELECT 1 FROM public.group_memberships gm
      WHERE gm.group_id = p_group AND gm.person_id = cm.person_id AND gm.valid_to IS NULL
        AND (v_guests OR NOT gm.guest));

  PERFORM app.chat_enforce_guardians(v_chat);
  RETURN v_chat;
END
$$;
--> statement-breakpoint

-- Retention (#18): overrides and revocations of activities past the club's
-- period go with the answers and attendance.
CREATE OR REPLACE FUNCTION app.purge_expired_attendance(OUT responses bigint, OUT attendance bigint)
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

  DELETE FROM public.activity_invitees i
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND i.club_id = v_club AND i.activity_id = a.id;

  DELETE FROM public.activity_invitee_overrides o
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND o.club_id = v_club AND o.activity_id = a.id;

  DELETE FROM public.activity_callup_revocations v
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND v.club_id = v_club AND v.activity_id = a.id;
END
$$;
--> statement-breakpoint

-- Erasure (P1.8b): the function of 0053 with the revocation reasons.
CREATE OR REPLACE FUNCTION privacy.erase_person(p_person_id uuid, p_reason text, p_replay boolean DEFAULT false)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_people_keys CONSTANT text[] := ARRAY[
    'given_name', 'family_name', 'birth_date', 'personal_identity_number',
    'personal_identity_number_hash', 'phone', 'address'];
  v_account_keys CONSTANT text[] := ARRAY['email', 'idp_subject'];
  v_profile_keys CONSTANT text[] := ARRAY['emergency_contacts', 'notes'];
  v_invitation_keys CONSTANT text[] := ARRAY['email'];
  v_response_keys CONSTANT text[] := ARRAY['note'];
  v_registration_keys CONSTANT text[] := ARRAY['answers', 'sensitive_answers'];
  v_join_keys CONSTANT text[] := ARRAY['message', 'decision_message'];
  v_waitlist_keys CONSTANT text[] := ARRAY['applicant_note', 'owner_note'];
  v_guardianship_keys CONSTANT text[] := ARRAY['consent_note', 'ended_reason'];
  v_consent_keys CONSTANT text[] := ARRAY['club_note'];
  v_carpool_keys CONSTANT text[] := ARRAY['departure_place', 'note'];
  v_claim_keys CONSTANT text[] := ARRAY['reason'];
  v_erased_email CONSTANT text := 'erased-' || p_person_id || '@erased.invalid';
  v_email text;
  v_invitation_ids uuid[];
  v_guardian_invitation_ids uuid[];
  v_changed boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE id = p_person_id) THEN
    -- Not in this database (for example created after the restore point).
    IF NOT p_replay THEN
      RAISE EXCEPTION 'person % does not exist', p_person_id USING ERRCODE = 'no_data_found';
    END IF;
    RETURN false;
  END IF;

  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.request_id',
    CASE WHEN p_replay THEN 'privacy:ledger-replay' ELSE 'privacy:erasure' END, true);

  IF NOT p_replay THEN
    INSERT INTO privacy.deletion_ledger (person_id, reason)
    VALUES (p_person_id, p_reason)
    ON CONFLICT (person_id) DO NOTHING;
  END IF;

  -- The login address, before it is replaced: invitations sent to it go too.
  SELECT email INTO v_email FROM public.accounts
  WHERE person_id = p_person_id AND email <> v_erased_email;

  UPDATE public.people
  SET given_name = '', family_name = '',
      birth_date = date_trunc('year', birth_date)::date,
      personal_identity_number = NULL, personal_identity_number_hash = NULL,
      phone = NULL, address = NULL, orphaned_since = NULL,
      anonymized_at = coalesce(anonymized_at, now())
  WHERE id = p_person_id
    AND (given_name <> '' OR family_name <> ''
      OR birth_date IS DISTINCT FROM date_trunc('year', birth_date)::date
      OR personal_identity_number IS NOT NULL OR phone IS NOT NULL OR address IS NOT NULL
      OR anonymized_at IS NULL);
  v_changed := FOUND;

  UPDATE public.accounts
  SET email = v_erased_email, idp_subject = NULL, notification_settings = '{}'
  WHERE person_id = p_person_id AND email <> v_erased_email;
  v_changed := v_changed OR FOUND;

  UPDATE public.club_profiles
  SET emergency_contacts = '[]', notes = NULL
  WHERE person_id = p_person_id AND (emergency_contacts <> '[]' OR notes IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Invitations sent to the person's email address.
  DELETE FROM public.account_invitations WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  WITH changed AS (
    UPDATE public.guardian_invitations
    SET email = v_erased_email, revoked_at = coalesce(revoked_at, CASE WHEN accepted_at IS NULL THEN now() END)
    WHERE email <> v_erased_email
      AND (accepted_by_person_id = p_person_id OR (v_email IS NOT NULL AND email = v_email))
    RETURNING id)
  SELECT array_agg(id) INTO v_guardian_invitation_ids FROM changed;
  v_changed := v_changed OR v_guardian_invitation_ids IS NOT NULL;
  WITH changed AS (
    UPDATE public.invitations SET email = v_erased_email
    WHERE v_email IS NOT NULL AND email = v_email
    RETURNING id)
  SELECT array_agg(id) INTO v_invitation_ids FROM changed;
  v_changed := v_changed OR v_invitation_ids IS NOT NULL;

  -- Notes to the leaders on the person's answers (P1.5; they may be about health).
  UPDATE public.activity_responses SET note = NULL
  WHERE person_id = p_person_id AND note IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- Answers to events' sign-up forms (P1.6): the sensitive ones deleted, the others cleared.
  UPDATE public.event_registrations SET answers = '{}', sensitive_answers = NULL
  WHERE person_id = p_person_id AND (answers <> '{}' OR sensitive_answers IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Join requests, waiting lists and guardianships: free text about the person (P1.8a).
  UPDATE public.join_requests SET message = NULL, decision_message = NULL
  WHERE person_id = p_person_id AND (message IS NOT NULL OR decision_message IS NOT NULL);
  v_changed := v_changed OR FOUND;
  UPDATE public.group_waitlist_entries SET applicant_note = NULL, owner_note = NULL
  WHERE person_id = p_person_id AND (applicant_note IS NOT NULL OR owner_note IS NOT NULL);
  v_changed := v_changed OR FOUND;
  UPDATE public.guardianships SET consent_note = NULL, ended_reason = NULL
  WHERE (ward_person_id = p_person_id OR guardian_person_id = p_person_id)
    AND (consent_note IS NOT NULL OR ended_reason IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Open consents end with the person (P1.8a); the club's notes on them go.
  UPDATE public.consents
  SET revoked_at = now(), revoked_reason = 'erased', club_note = NULL
  WHERE person_id = p_person_id AND revoked_at IS NULL;
  v_changed := v_changed OR FOUND;
  UPDATE public.consents SET club_note = NULL
  WHERE person_id = p_person_id AND club_note IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- Notifications (P1.7): the person's inbox, its deliveries (cascade) and
  -- push devices; the person is taken out of others' notices about them.
  DELETE FROM public.notifications WHERE recipient_person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.notifications SET about_person_ids = array_remove(about_person_ids, p_person_id)
  WHERE about_person_ids @> ARRAY[p_person_id];
  v_changed := v_changed OR FOUND;
  DELETE FROM public.push_devices d USING public.accounts a
  WHERE a.id = d.account_id AND a.person_id = p_person_id;
  v_changed := v_changed OR FOUND;

  -- Calendar feeds (P1.11): the person's feeds and their history; the person
  -- is taken out of others' feeds that name them.
  DELETE FROM history.record_changes h USING public.calendar_feeds f
  WHERE h.table_name = 'public.calendar_feeds' AND h.record_id = f.id AND f.person_id = p_person_id;
  DELETE FROM public.calendar_feeds WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.calendar_feeds SET person_ids = array_remove(person_ids, p_person_id)
  WHERE person_ids @> ARRAY[p_person_id];
  v_changed := v_changed OR FOUND;

  -- Protected identity (P1.12): who set a flag; the profile view log names
  -- nobody erased, in any club (the deletion ledger replays this too).
  UPDATE public.people SET protected_identity_set_by_person_id = NULL
  WHERE protected_identity_set_by_person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.club_profiles SET protected_identity_club_set_by_person_id = NULL
  WHERE protected_identity_club_set_by_person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  IF privacy.anonymize_profile_views(p_person_id, NULL, false) > 0 THEN
    v_changed := true;
  END IF;

  -- Chat (P2.1, ADR 0047): the person leaves every chat; their messages and
  -- reactions stay, shown as from "a former member" (the person row is
  -- anonymised above). Names written in others' messages are not rewritten.
  UPDATE public.chat_members SET status = 'left', left_at = now()
  WHERE person_id = p_person_id AND status <> 'left';
  v_changed := v_changed OR FOUND;

  -- Car pools (P2.5, ADR 0048): the person stays in drives and statistics
  -- as the anonymised person above; the free text of their drives' meeting
  -- place and the note go (they may say where they live).
  UPDATE public.carpool_offers SET departure_place = NULL, note = NULL
  WHERE driver_person_id = p_person_id AND (departure_place IS NOT NULL OR note IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Expense claims (P2.5 part B): kept for the accounting (the person is
  -- anonymised above); the attester's reason about the claimant goes.
  UPDATE public.expense_claims SET reason = NULL
  WHERE claimant_person_id = p_person_id AND reason IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- Volunteer duties (P2.6, ADR 0050): the person's stated unavailability
  -- goes; their shifts stay (as the anonymised person above) for the
  -- quotas and the statistics.
  DELETE FROM public.duty_unavailability WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;

  -- Background checks (P2.7, ADR 0051): the records and requests about the
  -- person go; grant reports keep their IDs (the person above is anonymised).
  DELETE FROM public.background_check_requests WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  DELETE FROM public.background_checks WHERE person_id = p_person_id;
  -- P2.10: a revoked call-up's reason is about the person (ADR 0056).
  DELETE FROM public.activity_callup_revocations WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;

  -- "Download my data" requests (P1.8b): the job deleted their files first.
  DELETE FROM public.data_exports
  WHERE subject_person_id = p_person_id OR requested_by_person_id = p_person_id;
  v_changed := v_changed OR FOUND;

  -- Record history, including the rows the statements above just wrote.
  UPDATE history.record_changes
  SET old_values = privacy.scrub(old_values, v_people_keys),
      new_values = privacy.scrub(new_values, v_people_keys)
  WHERE table_name = 'public.people' AND record_id = p_person_id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_account_keys),
      new_values = privacy.scrub(h.new_values, v_account_keys)
  FROM public.accounts a
  WHERE a.person_id = p_person_id AND h.table_name = 'public.accounts' AND h.record_id = a.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_profile_keys),
      new_values = privacy.scrub(h.new_values, v_profile_keys)
  FROM public.club_profiles p
  WHERE p.person_id = p_person_id AND h.table_name = 'public.club_profiles' AND h.record_id = p.id;
  UPDATE history.record_changes
  SET old_values = privacy.scrub(old_values, v_invitation_keys),
      new_values = privacy.scrub(new_values, v_invitation_keys)
  WHERE (table_name = 'public.account_invitations'
         AND p_person_id::text IN (old_values ->> 'person_id', new_values ->> 'person_id'))
     OR (table_name = 'public.guardian_invitations'
         AND (p_person_id::text IN (old_values ->> 'accepted_by_person_id', new_values ->> 'accepted_by_person_id')
              OR record_id = ANY (coalesce(v_guardian_invitation_ids, '{}'))))
     OR (table_name = 'public.invitations' AND record_id = ANY (coalesce(v_invitation_ids, '{}')));

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_response_keys),
      new_values = privacy.scrub(h.new_values, v_response_keys)
  FROM public.activity_responses r
  WHERE r.person_id = p_person_id AND h.table_name = 'public.activity_responses'
    AND h.record_id = r.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_registration_keys),
      new_values = privacy.scrub(h.new_values, v_registration_keys)
  FROM public.event_registrations r
  WHERE r.person_id = p_person_id AND h.table_name = 'public.event_registrations'
    AND h.record_id = r.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_join_keys),
      new_values = privacy.scrub(h.new_values, v_join_keys)
  FROM public.join_requests j
  WHERE j.person_id = p_person_id AND h.table_name = 'public.join_requests' AND h.record_id = j.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_waitlist_keys),
      new_values = privacy.scrub(h.new_values, v_waitlist_keys)
  FROM public.group_waitlist_entries w
  WHERE w.person_id = p_person_id AND h.table_name = 'public.group_waitlist_entries'
    AND h.record_id = w.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_guardianship_keys),
      new_values = privacy.scrub(h.new_values, v_guardianship_keys)
  FROM public.guardianships g
  WHERE (g.ward_person_id = p_person_id OR g.guardian_person_id = p_person_id)
    AND h.table_name = 'public.guardianships' AND h.record_id = g.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_consent_keys),
      new_values = privacy.scrub(h.new_values, v_consent_keys)
  FROM public.consents c
  WHERE c.person_id = p_person_id AND h.table_name = 'public.consents' AND h.record_id = c.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_carpool_keys),
      new_values = privacy.scrub(h.new_values, v_carpool_keys)
  FROM public.carpool_offers o
  WHERE o.driver_person_id = p_person_id AND h.table_name = 'public.carpool_offers'
    AND h.record_id = o.id;

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_claim_keys),
      new_values = privacy.scrub(h.new_values, v_claim_keys)
  FROM public.expense_claims c
  WHERE c.claimant_person_id = p_person_id AND h.table_name = 'public.expense_claims'
    AND h.record_id = c.id;

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;
