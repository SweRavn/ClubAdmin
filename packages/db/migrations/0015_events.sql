CREATE TABLE "event_activities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_activities_activity_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "event_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_groups_unique" UNIQUE("event_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "event_registrations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"registered_by_person_id" uuid NOT NULL,
	"status" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offer_expires_at" timestamp with time zone,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitive_answers" text,
	"decision_reason" text,
	"decided_by_person_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_registrations_status" CHECK ("event_registrations"."status" IN ('confirmed', 'waitlisted', 'offered', 'cancelled', 'declined', 'expired', 'removed')),
	CONSTRAINT "event_registrations_offer" CHECK ("event_registrations"."offer_expires_at" IS NULL OR "event_registrations"."status" = 'offered')
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"audience" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cancelled_reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"location_id" uuid,
	"location_text" text,
	"price_text" text,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone NOT NULL,
	"cancellation_closes_at" timestamp with time zone,
	"capacity" integer,
	"waitlist_mode" text DEFAULT 'offer' NOT NULL,
	"offer_reply_hours" integer DEFAULT 24 NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_club_id_unique" UNIQUE("club_id","id"),
	CONSTRAINT "events_audience" CHECK ("events"."audience" IN ('groups', 'club')),
	CONSTRAINT "events_status" CHECK ("events"."status" IN ('draft', 'published', 'cancelled')),
	CONSTRAINT "events_waitlist_mode" CHECK ("events"."waitlist_mode" IN ('none', 'auto', 'offer')),
	CONSTRAINT "events_period" CHECK ("events"."ends_at" > "events"."starts_at"),
	CONSTRAINT "events_capacity" CHECK ("events"."capacity" IS NULL OR "events"."capacity" > 0),
	CONSTRAINT "events_offer_reply_hours" CHECK ("events"."offer_reply_hours" BETWEEN 1 AND 168),
	CONSTRAINT "events_cancelled_reason" CHECK ("events"."cancelled_reason" IS NULL OR "events"."status" = 'cancelled')
);
--> statement-breakpoint
ALTER TABLE "event_activities" ADD CONSTRAINT "event_activities_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_activities" ADD CONSTRAINT "event_activities_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."events"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_activities" ADD CONSTRAINT "event_activities_activity_fk" FOREIGN KEY ("club_id","activity_id") REFERENCES "public"."activities"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_groups" ADD CONSTRAINT "event_groups_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_groups" ADD CONSTRAINT "event_groups_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."events"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_groups" ADD CONSTRAINT "event_groups_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_registered_by_person_id_people_id_fk" FOREIGN KEY ("registered_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."events"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_activities_event_idx" ON "event_activities" USING btree ("club_id","event_id");--> statement-breakpoint
CREATE INDEX "event_groups_group_idx" ON "event_groups" USING btree ("club_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_registrations_open_unique" ON "event_registrations" USING btree ("event_id","person_id") WHERE "event_registrations"."status" IN ('confirmed', 'waitlisted', 'offered');--> statement-breakpoint
CREATE INDEX "event_registrations_event_idx" ON "event_registrations" USING btree ("club_id","event_id","status","queued_at");--> statement-breakpoint
CREATE INDEX "event_registrations_person_idx" ON "event_registrations" USING btree ("person_id","event_id");--> statement-breakpoint
CREATE INDEX "event_registrations_registrant_idx" ON "event_registrations" USING btree ("registered_by_person_id");--> statement-breakpoint
CREATE INDEX "event_registrations_offer_idx" ON "event_registrations" USING btree ("offer_expires_at") WHERE "event_registrations"."status" = 'offered';--> statement-breakpoint
CREATE INDEX "events_club_starts_idx" ON "events" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE INDEX "events_creator_idx" ON "events" USING btree ("created_by_person_id");--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.6, ADR 0038): events with sign-up.
-------------------------------------------------------------------------------

SELECT app.enable_tenant_rls('public.events'),
  app.enable_updated_at('public.events'),
  history.enable_history('public.events');
SELECT app.enable_tenant_rls('public.event_groups'),
  app.enable_updated_at('public.event_groups'),
  history.enable_history('public.event_groups');
SELECT app.enable_tenant_rls('public.event_activities'),
  app.enable_updated_at('public.event_activities'),
  history.enable_history('public.event_activities');
SELECT app.enable_tenant_rls('public.event_registrations'),
  app.enable_updated_at('public.event_registrations'),
  history.enable_history('public.event_registrations');
--> statement-breakpoint

-- Outside a club context (the authorization module resolving /events/:id,
-- "My events"), people related to the club read an event, its groups and
-- activities, as activities' insider_read does.
CREATE POLICY insider_read ON public.events FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
CREATE POLICY insider_read ON public.event_groups FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
CREATE POLICY insider_read ON public.event_activities FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
-- "My events" shows my and my wards' registrations across clubs.
CREATE POLICY own_read ON public.event_registrations FOR SELECT
  USING (person_id = ANY ((SELECT app.self_and_wards())::uuid[]));
--> statement-breakpoint

-- The club, audience, status and groups of an event, for the authorization
-- module's resource loader (IDs only; runs as the caller).
CREATE FUNCTION app.event_scope(p_event uuid)
  RETURNS TABLE (club_id uuid, audience text, status text, group_ids uuid[])
  LANGUAGE sql STABLE
  AS $$
  SELECT e.club_id, e.audience, e.status,
    coalesce(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}')
  FROM public.events e LEFT JOIN public.event_groups g ON g.event_id = e.id
  WHERE e.id = p_event
  GROUP BY e.club_id, e.audience, e.status
$$;
--> statement-breakpoint

-- Retention (P1.6): answers to sensitive questions are deleted 30 days after
-- the event ended; registrations follow the club's attendance retention
-- (#18). Run by the worker's attendance:retention job as a system job.
CREATE FUNCTION app.purge_expired_event_data(OUT registrations bigint, OUT sensitive_answers bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_club uuid := app.current_club_id();
  v_cutoff timestamptz;
BEGIN
  IF v_club IS NULL OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'system_job' THEN
    RAISE EXCEPTION 'purge_expired_event_data runs as a system job in a club'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT now() - make_interval(months => c.attendance_retention_months) INTO v_cutoff
  FROM public.clubs c WHERE c.id = v_club;

  UPDATE public.event_registrations r SET sensitive_answers = NULL
  FROM public.events e
  WHERE e.club_id = v_club AND e.ends_at < now() - interval '30 days'
    AND r.club_id = v_club AND r.event_id = e.id AND r.sensitive_answers IS NOT NULL;
  GET DIAGNOSTICS sensitive_answers = ROW_COUNT;

  DELETE FROM public.event_registrations r
  USING public.events e
  WHERE e.club_id = v_club AND e.ends_at < v_cutoff
    AND r.club_id = v_club AND r.event_id = e.id;
  GET DIAGNOSTICS registrations = ROW_COUNT;
END
$$;

REVOKE ALL ON FUNCTION app.purge_expired_event_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_event_data() TO clubadmin_app;
--> statement-breakpoint

-- System jobs read registrations across clubs: the API's events:expire_offers
-- job finds offers past their time, then expires each in its club.
CREATE POLICY system_read ON public.event_registrations FOR SELECT USING (app.is_system());
--> statement-breakpoint

-- Erasure (docs/gdpr.md) also clears a person's answers to sign-up forms.
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

  UPDATE public.people
  SET given_name = '', family_name = '',
      birth_date = date_trunc('year', birth_date)::date,
      personal_identity_number = NULL, personal_identity_number_hash = NULL,
      phone = NULL, address = NULL,
      anonymized_at = coalesce(anonymized_at, now())
  WHERE id = p_person_id
    AND (given_name <> '' OR family_name <> ''
      OR birth_date IS DISTINCT FROM date_trunc('year', birth_date)::date
      OR personal_identity_number IS NOT NULL OR phone IS NOT NULL OR address IS NOT NULL
      OR anonymized_at IS NULL);
  v_changed := FOUND;

  UPDATE public.accounts
  SET email = 'erased-' || p_person_id || '@erased.invalid', idp_subject = NULL,
      notification_settings = '{}'
  WHERE person_id = p_person_id AND email <> 'erased-' || p_person_id || '@erased.invalid';
  v_changed := v_changed OR FOUND;

  UPDATE public.club_profiles
  SET emergency_contacts = '[]', notes = NULL
  WHERE person_id = p_person_id AND (emergency_contacts <> '[]' OR notes IS NOT NULL);
  v_changed := v_changed OR FOUND;

  -- Invitations sent to the person's email address.
  DELETE FROM public.account_invitations WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  UPDATE public.guardian_invitations
  SET email = 'erased-' || p_person_id || '@erased.invalid'
  WHERE accepted_by_person_id = p_person_id AND email <> 'erased-' || p_person_id || '@erased.invalid';
  v_changed := v_changed OR FOUND;

  -- Notes to the leaders on the person's answers (P1.5; they may be about health).
  UPDATE public.activity_responses SET note = NULL
  WHERE person_id = p_person_id AND note IS NOT NULL;
  v_changed := v_changed OR FOUND;

  -- Answers to events' sign-up forms (P1.6): the sensitive ones deleted, the others cleared.
  UPDATE public.event_registrations SET answers = '{}', sensitive_answers = NULL
  WHERE person_id = p_person_id AND (answers <> '{}' OR sensitive_answers IS NOT NULL);
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
         AND p_person_id::text IN (old_values ->> 'accepted_by_person_id', new_values ->> 'accepted_by_person_id'));

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

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;

GRANT UPDATE ON public.event_registrations TO clubadmin_retention;
