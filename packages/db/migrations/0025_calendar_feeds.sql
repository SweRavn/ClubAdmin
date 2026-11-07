-- SPDX-License-Identifier: AGPL-3.0-only
-- P1.11, calendar subscriptions (ADR 0021, ADR 0044): personal secret feed
-- URLs (a global table owned by a person; only sha256 of the secret is
-- stored) and what calendar feeds show of an activity in the read model
-- (sequence, meeting place, the location's address and position).
CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"club_id" uuid,
	"group_id" uuid,
	"person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"access_lost_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feeds_token_unique" UNIQUE("token_hash"),
	CONSTRAINT "calendar_feeds_scope" CHECK ("calendar_feeds"."scope" IN ('my_schedule', 'group', 'club')),
	CONSTRAINT "calendar_feeds_scope_target" CHECK (("calendar_feeds"."scope" = 'my_schedule' AND "calendar_feeds"."club_id" IS NULL AND "calendar_feeds"."group_id" IS NULL)
        OR ("calendar_feeds"."scope" = 'group' AND "calendar_feeds"."club_id" IS NOT NULL AND "calendar_feeds"."group_id" IS NOT NULL)
        OR ("calendar_feeds"."scope" = 'club' AND "calendar_feeds"."club_id" IS NOT NULL AND "calendar_feeds"."group_id" IS NULL)),
	CONSTRAINT "calendar_feeds_revoked_reason" CHECK (("calendar_feeds"."revoked_at" IS NULL) = ("calendar_feeds"."revoked_reason" IS NULL) AND ("calendar_feeds"."revoked_reason" IS NULL OR "calendar_feeds"."revoked_reason" IN ('owner', 'regenerated', 'access_lost', 'unused', 'erased'))),
	CONSTRAINT "calendar_feeds_label" CHECK ("calendar_feeds"."label" IS NULL OR char_length("calendar_feeds"."label") <= 60)
);
--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "meet_place" text;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_feeds_person_idx" ON "calendar_feeds" USING btree ("person_id") WHERE "calendar_feeds"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "calendar_feeds_revoked_idx" ON "calendar_feeds" USING btree ("revoked_at") WHERE "calendar_feeds"."revoked_at" IS NOT NULL;;--> statement-breakpoint
-- calendar:retention revokes feeds nobody fetched for 12 months.
CREATE INDEX "calendar_feeds_unused_idx" ON "calendar_feeds" USING btree ((coalesce("last_fetched_at", "created_at"))) WHERE "calendar_feeds"."revoked_at" IS NULL;--> statement-breakpoint

-- The owner reads and changes their own feeds; system jobs (retention) all.
ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_feeds FORCE ROW LEVEL SECURITY;
CREATE POLICY own_feeds ON public.calendar_feeds
  USING (app.is_system() OR person_id = app.current_person_id())
  WITH CHECK (app.is_system() OR person_id = app.current_person_id());
CREATE POLICY lookup_read ON public.calendar_feeds FOR SELECT
  USING (app.setting('app.lookup') = 'calendar_feed');
CREATE POLICY retention_access ON public.calendar_feeds TO clubadmin_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_feeds TO clubadmin_app;
GRANT SELECT, UPDATE, DELETE ON public.calendar_feeds TO clubadmin_retention;
SELECT app.enable_updated_at('public.calendar_feeds'),
  history.enable_history('public.calendar_feeds', redact => ARRAY['token_hash'],
    ignore => ARRAY['last_fetched_at']);
--> statement-breakpoint

-- A fetch knows only the secret: the open feed it belongs to. Revoked and
-- unknown secrets look the same. The owner's account and rights are checked
-- afterwards, in a transaction as the owner.
CREATE FUNCTION app.find_calendar_feed(p_token_hash text)
  RETURNS TABLE (id uuid, person_id uuid, scope text, club_id uuid, group_id uuid,
                 person_ids uuid[], last_fetched_at timestamptz, access_lost_at timestamptz)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM set_config('app.lookup', 'calendar_feed', true);
  RETURN QUERY
  SELECT f.id, f.person_id, f.scope, f.club_id, f.group_id, f.person_ids,
    f.last_fetched_at, f.access_lost_at
  FROM public.calendar_feeds f
  WHERE f.token_hash = p_token_hash AND f.revoked_at IS NULL;
  PERFORM set_config('app.lookup', '', true);
END
$$;
GRANT EXECUTE ON FUNCTION app.find_calendar_feed(text) TO clubadmin_app;
--> statement-breakpoint

-- What feeds show, filled club by club (the read model is forced under RLS).
DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    UPDATE public.schedule_entries se
    SET sequence = a.sequence, meet_place = a.meet_place,
      address = nullif(concat_ws(', ', l.street, nullif(concat_ws(' ', l.postal_code, l.city), '')), ''),
      latitude = l.latitude, longitude = l.longitude
    FROM public.activities a LEFT JOIN public.locations l ON l.id = a.location_id
    WHERE se.club_id = v_club AND a.id = se.activity_id;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Erasure deletes the person's feeds (P1.8a's function, extended).
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

