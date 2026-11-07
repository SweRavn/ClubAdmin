CREATE TABLE "profile_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid,
	"viewed_person_id" uuid,
	"viewer_person_id" uuid,
	"on_behalf_of_person_id" uuid,
	"viewer_kind" text NOT NULL,
	"surface" text NOT NULL,
	"protected" boolean NOT NULL,
	"day" date NOT NULL,
	"first_viewed_at" timestamp with time zone NOT NULL,
	"last_viewed_at" timestamp with time zone NOT NULL,
	"view_count" integer DEFAULT 1 NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_views_viewer_kind" CHECK ("profile_views"."viewer_kind" IN ('person', 'operator')),
	CONSTRAINT "profile_views_surface" CHECK ("profile_views"."surface" IN ('profile', 'history')),
	CONSTRAINT "profile_views_count" CHECK ("profile_views"."view_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "club_profiles" ADD COLUMN "protected_identity_club_set_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "club_profiles" ADD COLUMN "protected_identity_club_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "profile_view_logging" text DEFAULT 'protected_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "protected_identity_set_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "protected_identity_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewed_person_id_people_id_fk" FOREIGN KEY ("viewed_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewer_person_id_people_id_fk" FOREIGN KEY ("viewer_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_on_behalf_of_person_id_people_id_fk" FOREIGN KEY ("on_behalf_of_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_views_key" ON "profile_views" USING btree ("club_id","viewer_person_id","viewed_person_id","surface","day") NULLS NOT DISTINCT WHERE "profile_views"."anonymized_at" IS NULL;--> statement-breakpoint
CREATE INDEX "profile_views_club_idx" ON "profile_views" USING btree ("club_id","last_viewed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "profile_views_viewed_idx" ON "profile_views" USING btree ("viewed_person_id","last_viewed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "profile_views_viewer_idx" ON "profile_views" USING btree ("viewer_person_id");--> statement-breakpoint
CREATE INDEX "profile_views_club_viewed_idx" ON "profile_views" USING btree ("club_id","viewed_person_id");--> statement-breakpoint
CREATE INDEX "profile_views_retention_idx" ON "profile_views" USING btree ("last_viewed_at");--> statement-breakpoint
ALTER TABLE "club_profiles" ADD CONSTRAINT "club_profiles_protected_identity_club_set_by_person_id_people_id_fk" FOREIGN KEY ("protected_identity_club_set_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_protected_identity_set_by_person_id_people_id_fk" FOREIGN KEY ("protected_identity_set_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_profile_view_logging" CHECK ("clubs"."profile_view_logging" IN ('protected_only', 'all'));--> statement-breakpoint

-- Profile view log (P1.12): the club's rows under tenant RLS; system jobs and
-- the retention role all; app.record_profile_view and app.profile_view_log
-- reach rows without a club through the lookup setting (ADR 0032 pattern).
ALTER TABLE public.profile_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_views FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON public.profile_views
  USING (club_id IS NOT NULL AND club_id = app.current_club_id())
  WITH CHECK (club_id IS NOT NULL AND club_id = app.current_club_id());
CREATE POLICY system_access ON public.profile_views
  USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY lookup_access ON public.profile_views
  USING (app.setting('app.lookup') = 'profile_view')
  WITH CHECK (app.setting('app.lookup') = 'profile_view');
CREATE POLICY retention_access ON public.profile_views TO clubadmin_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_views TO clubadmin_app;
GRANT SELECT, UPDATE, DELETE ON public.profile_views TO clubadmin_retention;
SELECT app.enable_updated_at('public.profile_views');
--> statement-breakpoint

-- Who left a club stops being named in its profile view log, also after a
-- restore (replayed like the deletion ledger; IDs only, kept 13 months).
CREATE TABLE privacy.anonymization_ledger (
  person_id uuid NOT NULL,
  club_id uuid NOT NULL,
  scope text NOT NULL CONSTRAINT anonymization_ledger_scope CHECK (scope IN ('profile_views')),
  anonymized_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, club_id, scope)
);
CREATE INDEX anonymization_ledger_age_idx ON privacy.anonymization_ledger (anonymized_at);
GRANT SELECT, INSERT ON privacy.anonymization_ledger TO clubadmin_app, clubadmin_retention;
GRANT DELETE ON privacy.anonymization_ledger TO clubadmin_app, clubadmin_retention;
--> statement-breakpoint

-- Records one profile view by the current person (one upsert). Views of
-- protected people are always logged; others only in a club that logs every
-- view. Reading a log is not a view; viewing oneself is not logged. Returns
-- whether views of this profile are logged (the viewer is told).
CREATE FUNCTION app.record_profile_view(p_club uuid, p_person uuid, p_surface text, p_protected boolean)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_viewer uuid := app.current_person_id();
  v_zone text := 'UTC';
  v_mode text := 'protected_only';
  v_now timestamptz := now();
BEGIN
  IF p_club IS NOT NULL THEN
    SELECT c.time_zone, c.profile_view_logging INTO v_zone, v_mode
    FROM public.clubs c WHERE c.id = p_club;
  END IF;
  IF NOT p_protected AND (p_club IS NULL OR v_mode IS DISTINCT FROM 'all') THEN
    RETURN false;
  END IF;
  IF v_viewer IS NULL OR v_viewer = p_person THEN
    RETURN true;
  END IF;
  PERFORM set_config('app.lookup', 'profile_view', true);
  INSERT INTO public.profile_views AS v (club_id, viewed_person_id, viewer_person_id,
    on_behalf_of_person_id, viewer_kind, surface, protected, day, first_viewed_at, last_viewed_at)
  VALUES (p_club, p_person, v_viewer, app.current_on_behalf_of(),
    CASE WHEN app.current_actor_kind() = 'operator' THEN 'operator' ELSE 'person' END,
    p_surface, p_protected, (v_now AT TIME ZONE coalesce(v_zone, 'UTC'))::date, v_now, v_now)
  ON CONFLICT (club_id, viewer_person_id, viewed_person_id, surface, day)
    WHERE anonymized_at IS NULL
  DO UPDATE SET last_viewed_at = excluded.last_viewed_at, view_count = v.view_count + 1,
    protected = v.protected OR excluded.protected,
    on_behalf_of_person_id = coalesce(excluded.on_behalf_of_person_id, v.on_behalf_of_person_id);
  PERFORM set_config('app.lookup', '', true);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION app.record_profile_view(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_profile_view(uuid, uuid, text, boolean) TO clubadmin_app;
--> statement-breakpoint

-- One person's log across clubs, newest first (keyset: the last row's ID):
-- only for the person and their full guardians; anyone else gets nothing.
CREATE FUNCTION app.profile_view_log(p_person_id uuid, p_cursor uuid, p_limit integer)
  RETURNS TABLE (id uuid, club_id uuid, viewer_person_id uuid, on_behalf_of_person_id uuid,
                 viewer_kind text, surface text, protected boolean, day date,
                 first_viewed_at timestamptz, last_viewed_at timestamptz, view_count integer,
                 anonymized boolean)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_before_at timestamptz;
  v_before_id uuid;
BEGIN
  IF app.current_person_id() IS NULL
     OR (p_person_id <> app.current_person_id() AND NOT app.is_full_guardian_of(p_person_id)) THEN
    RETURN;
  END IF;
  PERFORM set_config('app.lookup', 'profile_view', true);
  IF p_cursor IS NOT NULL THEN
    SELECT v.last_viewed_at, v.id INTO v_before_at, v_before_id
    FROM public.profile_views v WHERE v.id = p_cursor AND v.viewed_person_id = p_person_id;
  END IF;
  RETURN QUERY
  SELECT v.id, v.club_id, v.viewer_person_id, v.on_behalf_of_person_id, v.viewer_kind,
    v.surface, v.protected, v.day, v.first_viewed_at, v.last_viewed_at, v.view_count,
    v.anonymized_at IS NOT NULL
  FROM public.profile_views v
  WHERE v.viewed_person_id = p_person_id
    AND (v_before_at IS NULL OR (v.last_viewed_at, v.id) < (v_before_at, v_before_id))
  ORDER BY v.last_viewed_at DESC, v.id DESC
  LIMIT least(greatest(p_limit, 1), 201);
  PERFORM set_config('app.lookup', '', true);
END
$$;
REVOKE ALL ON FUNCTION app.profile_view_log(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_view_log(uuid, uuid, integer) TO clubadmin_app;
--> statement-breakpoint

-- Does the person still have anything to do with the club: an open
-- membership (also of a ward), a role, a group function or a current
-- employment? A paused membership counts (P1.12 decision 9).
CREATE FUNCTION privacy.has_club_relationship(p_person uuid, p_club uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.club_memberships m
      WHERE m.club_id = p_club AND m.valid_to IS NULL AND m.status IN ('active', 'paused')
        AND (m.person_id = p_person OR m.person_id IN (
          SELECT g.ward_person_id FROM public.guardianships g
          WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL)))
    OR EXISTS (SELECT 1 FROM public.club_role_assignments r
      WHERE r.club_id = p_club AND r.person_id = p_person AND r.valid_to IS NULL)
    OR EXISTS (SELECT 1 FROM public.group_memberships gm
      WHERE gm.club_id = p_club AND gm.person_id = p_person AND gm.valid_to IS NULL)
    OR EXISTS (SELECT 1 FROM public.employments e
      WHERE e.club_id = p_club AND e.person_id = p_person
        AND e.starts_on <= current_date AND (e.ends_on IS NULL OR e.ends_on >= current_date))
$$;
REVOKE ALL ON FUNCTION privacy.has_club_relationship(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.has_club_relationship(uuid, uuid) TO clubadmin_app, clubadmin_retention;
--> statement-breakpoint

-- Whether someone is an active full guardian of a ward (the removal rule's
-- "the guardian who set it is no longer one"; readable without a relationship).
CREATE FUNCTION privacy.is_active_full_guardian(p_guardian uuid, p_ward uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.guardianships g
    WHERE g.guardian_person_id = p_guardian AND g.ward_person_id = p_ward
      AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active' AND g.valid_to IS NULL)
$$;
REVOKE ALL ON FUNCTION privacy.is_active_full_guardian(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.is_active_full_guardian(uuid, uuid) TO clubadmin_app;
--> statement-breakpoint

-- The clubs where a person or one of their wards is an active or paused
-- member (P1.12: who to tell when a global flag changes). The worker reads
-- them through this lookup only; club IDs, nothing else.
CREATE POLICY lookup_person_clubs ON public.club_memberships FOR SELECT
  USING (app.setting('app.lookup') = 'person_clubs');
CREATE FUNCTION privacy.person_club_ids(p_person uuid) RETURNS SETOF uuid
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM set_config('app.lookup', 'person_clubs', true);
  RETURN QUERY
  SELECT DISTINCT m.club_id FROM public.club_memberships m
  WHERE m.valid_to IS NULL AND m.status IN ('active', 'paused')
    AND (m.person_id = p_person OR m.person_id IN (
      SELECT g.ward_person_id FROM public.guardianships g
      WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL));
  PERFORM set_config('app.lookup', '', true);
END
$$;
REVOKE ALL ON FUNCTION privacy.person_club_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.person_club_ids(uuid) TO clubadmin_app;
--> statement-breakpoint

-- Takes the person out of a club's profile view log (p_club null: every
-- club and the rows without a club, as erasure does). With p_ledger the
-- club's anonymisation is recorded for replays after a restore. Returns the
-- rows changed. Runs as a system job, the retention role or an operator.
CREATE FUNCTION privacy.anonymize_profile_views(p_person uuid, p_club uuid, p_ledger boolean)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_rows integer;
  v_total integer := 0;
BEGIN
  UPDATE public.profile_views
  SET viewed_person_id = NULL, anonymized_at = coalesce(anonymized_at, now())
  WHERE viewed_person_id = p_person AND (p_club IS NULL OR club_id = p_club);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  UPDATE public.profile_views
  SET viewer_person_id = NULL, anonymized_at = coalesce(anonymized_at, now())
  WHERE viewer_person_id = p_person AND (p_club IS NULL OR club_id = p_club);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  UPDATE public.profile_views
  SET on_behalf_of_person_id = NULL, anonymized_at = coalesce(anonymized_at, now())
  WHERE on_behalf_of_person_id = p_person AND (p_club IS NULL OR club_id = p_club);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  IF p_ledger AND p_club IS NOT NULL THEN
    INSERT INTO privacy.anonymization_ledger (person_id, club_id, scope)
    VALUES (p_person, p_club, 'profile_views')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN v_total;
END
$$;
REVOKE ALL ON FUNCTION privacy.anonymize_profile_views(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.anonymize_profile_views(uuid, uuid, boolean) TO clubadmin_app, clubadmin_retention;
--> statement-breakpoint

-- The replay after a restore also applies the anonymisation ledger. The
-- exported ledger (next to the backups) holds both kinds: entries with
-- "kind": "anonymization" (person_id, club_id, scope, erased_at = when) and
-- deletions (no kind, as before).
CREATE OR REPLACE FUNCTION privacy.replay_deletion_ledger(p_external jsonb DEFAULT '[]')
  RETURNS TABLE (ledger_entries integer, added integer, erased integer)
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_entry record;
BEGIN
  ledger_entries := 0;
  added := 0;
  erased := 0;
  INSERT INTO privacy.deletion_ledger (person_id, erased_at, reason)
  SELECT (e ->> 'person_id')::uuid, coalesce((e ->> 'erased_at')::timestamptz, now()),
         coalesce(e ->> 'reason', 'restored')
  FROM jsonb_array_elements(coalesce(p_external, '[]')) AS e
  WHERE coalesce(e ->> 'kind', 'deletion') = 'deletion'
  ON CONFLICT (person_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  INSERT INTO privacy.anonymization_ledger (person_id, club_id, scope, anonymized_at)
  SELECT (e ->> 'person_id')::uuid, (e ->> 'club_id')::uuid, e ->> 'scope',
         coalesce((e ->> 'erased_at')::timestamptz, now())
  FROM jsonb_array_elements(coalesce(p_external, '[]')) AS e
  WHERE e ->> 'kind' = 'anonymization'
  ON CONFLICT DO NOTHING;

  FOR v_entry IN SELECT person_id, reason FROM privacy.deletion_ledger ORDER BY erased_at LOOP
    ledger_entries := ledger_entries + 1;
    IF privacy.erase_person(v_entry.person_id, v_entry.reason, true) THEN
      erased := erased + 1;
    END IF;
  END LOOP;
  PERFORM set_config('app.actor_kind', 'system_job', true);
  FOR v_entry IN SELECT person_id, club_id FROM privacy.anonymization_ledger
      WHERE scope = 'profile_views' ORDER BY anonymized_at LOOP
    PERFORM privacy.anonymize_profile_views(v_entry.person_id, v_entry.club_id, false);
  END LOOP;
  RETURN NEXT;
END
$$;
--> statement-breakpoint

-- Erasure also takes the person out of every profile view log (P1.12).
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

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;

--> statement-breakpoint
-- The access log so far (audit events person.protected.viewed) moves to the
-- profile view log, one row per club, viewer, person, surface and day; the
-- events expire with the audit log. The profile controller writes no more.
INSERT INTO public.profile_views (club_id, viewed_person_id, viewer_person_id,
  on_behalf_of_person_id, viewer_kind, surface, protected, day, first_viewed_at,
  last_viewed_at, view_count)
SELECT e.club_id, e.resource_id, e.actor_person_id, max(e.on_behalf_of_person_id::text)::uuid,
  CASE WHEN bool_or(e.actor_kind = 'operator') THEN 'operator' ELSE 'person' END,
  CASE WHEN e.changed_fields @> ARRAY['history'] THEN 'history' ELSE 'profile' END,
  true, (e.created_at AT TIME ZONE coalesce(c.time_zone, 'UTC'))::date,
  min(e.created_at), max(e.created_at), count(*)::int
FROM audit.events e
LEFT JOIN public.clubs c ON c.id = e.club_id
WHERE e.action = 'person.protected.viewed' AND e.actor_person_id IS NOT NULL
  AND e.resource_id IS NOT NULL
GROUP BY e.club_id, e.resource_id, e.actor_person_id,
  CASE WHEN e.changed_fields @> ARRAY['history'] THEN 'history' ELSE 'profile' END,
  (e.created_at AT TIME ZONE coalesce(c.time_zone, 'UTC'))::date;
