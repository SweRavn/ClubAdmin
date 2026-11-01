CREATE TABLE "club_privacy_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"template_version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"decision_id" uuid,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_privacy_policies_version_unique" UNIQUE("club_id","version"),
	CONSTRAINT "club_privacy_policies_version" CHECK ("club_privacy_policies"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "club_setting_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"body" text NOT NULL,
	"decided_on" date NOT NULL,
	"reference" text NOT NULL,
	"effective_from" date NOT NULL,
	"settings" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"recorded_by_person_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_setting_decisions_body" CHECK ("club_setting_decisions"."body" IN ('board', 'annual_meeting', 'extra_meeting')),
	CONSTRAINT "club_setting_decisions_reference" CHECK (length("club_setting_decisions"."reference") BETWEEN 1 AND 200),
	CONSTRAINT "club_setting_decisions_effective" CHECK ("club_setting_decisions"."effective_from" >= "club_setting_decisions"."decided_on")
);
--> statement-breakpoint
CREATE TABLE "consent_texts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"version" integer NOT NULL,
	"texts" jsonb NOT NULL,
	"published_by_person_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_texts_version_unique" UNIQUE("club_id","purpose","version"),
	CONSTRAINT "consent_texts_purpose" CHECK ("consent_texts"."purpose" IN ('photo_publication', 'video_publication', 'streaming', 'marketing', 'federation_sharing', 'contacts_group', 'contacts_club')),
	CONSTRAINT "consent_texts_version" CHECK ("consent_texts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_purpose";--> statement-breakpoint
ALTER TABLE "club_profiles" ADD COLUMN "club_data_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "consent_purposes" text[] DEFAULT '{photo_publication,video_publication}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "consent_reconfirm_on_new_version" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "former_member_retention_months" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "privacy_contact_email" text;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "source" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "club_note" text;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "orphaned_since" timestamp with time zone;--> statement-breakpoint
-- Existing consents (written by the seed only) name a published text and who
-- gave them (P1.8a). The owner is subject to the forced row-level security
-- like everyone else; it is lifted for these two statements of the
-- migration's own transaction only.
ALTER TABLE public.consents NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.consents SET text_version = 'default:1'
WHERE text_version !~ '^(default|club):[1-9][0-9]*$';--> statement-breakpoint
UPDATE public.consents SET source = 'guardian'
WHERE source = 'self' AND given_by_person_id <> person_id;--> statement-breakpoint
ALTER TABLE public.consents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "club_privacy_policies" ADD CONSTRAINT "club_privacy_policies_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_privacy_policies" ADD CONSTRAINT "club_privacy_policies_decision_id_club_setting_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."club_setting_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_setting_decisions" ADD CONSTRAINT "club_setting_decisions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_setting_decisions" ADD CONSTRAINT "club_setting_decisions_recorded_by_person_id_people_id_fk" FOREIGN KEY ("recorded_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_texts" ADD CONSTRAINT "consent_texts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_texts" ADD CONSTRAINT "consent_texts_published_by_person_id_people_id_fk" FOREIGN KEY ("published_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_setting_decisions_club_idx" ON "club_setting_decisions" USING btree ("club_id","effective_from" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "club_setting_decisions_pending_idx" ON "club_setting_decisions" USING btree ("effective_from") WHERE "club_setting_decisions"."applied_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_memberships_left_idx" ON "club_memberships" USING btree ("club_id","valid_to") WHERE "club_memberships"."status" = 'left';--> statement-breakpoint
CREATE INDEX "consents_club_purpose_idx" ON "consents" USING btree ("club_id","purpose","person_id") WHERE "consents"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "people_orphaned_idx" ON "people" USING btree ("orphaned_since") WHERE "people"."orphaned_since" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_consent_purposes" CHECK ("clubs"."consent_purposes" <@ ARRAY['photo_publication', 'video_publication', 'streaming', 'marketing', 'federation_sharing', 'contacts_group', 'contacts_club']::text[]);--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_former_member_retention_months" CHECK ("clubs"."former_member_retention_months" BETWEEN 6 AND 120);--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_privacy_contact_email" CHECK ("clubs"."privacy_contact_email" IS NULL OR (length("clubs"."privacy_contact_email") <= 254 AND "clubs"."privacy_contact_email" ~ '^[^@\s]+@[^@\s]+$'));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_source" CHECK ("consents"."source" IN ('self', 'guardian', 'club_record'));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_revoked_reason" CHECK ("consents"."revoked_reason" IS NULL OR "consents"."revoked_reason" IN ('withdrawn', 'left_club', 'superseded', 'erased', 'not_applicable'));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_club_note" CHECK ("consents"."club_note" IS NULL OR ("consents"."source" = 'club_record' AND length("consents"."club_note") <= 500));--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_text_version" CHECK ("consents"."text_version" ~ '^(default|club):[1-9][0-9]*$');--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_purpose" CHECK ("consents"."purpose" IN ('photo_publication', 'video_publication', 'streaming', 'marketing', 'federation_sharing', 'contacts_group', 'contacts_club'));
--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.8a, ADR 0041): consents, the club's privacy policy
-- and board decisions, the former-member purge, orphaned people, erasure.
-------------------------------------------------------------------------------

-- Club-owned tables: tenant RLS, updated_at, record history. Members read
-- their club's texts, decisions and policy (every insider), as they read the
-- club (the array form of ADR 0040).
SELECT app.enable_tenant_rls('public.consent_texts'),
  app.enable_updated_at('public.consent_texts'),
  history.enable_history('public.consent_texts');
SELECT app.enable_tenant_rls('public.club_setting_decisions'),
  app.enable_updated_at('public.club_setting_decisions'),
  history.enable_history('public.club_setting_decisions');
SELECT app.enable_tenant_rls('public.club_privacy_policies'),
  app.enable_updated_at('public.club_privacy_policies'),
  history.enable_history('public.club_privacy_policies');
CREATE POLICY insider_read ON public.consent_texts FOR SELECT
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
CREATE POLICY insider_read ON public.club_setting_decisions FOR SELECT
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
CREATE POLICY insider_read ON public.club_privacy_policies FOR SELECT
  USING (app.current_club_id() IS NULL AND club_id = ANY ((SELECT app.related_club_ids())::uuid[]));
--> statement-breakpoint

-- Published texts, policies and recorded decisions are never edited: a new
-- version or a new decision replaces them. A decision only records when it
-- was applied. Consents are revoked, never deleted, by the app.
REVOKE UPDATE, DELETE ON public.consent_texts, public.club_privacy_policies
  FROM clubadmin_app, clubadmin_operator;
REVOKE UPDATE, DELETE ON public.club_setting_decisions FROM clubadmin_app, clubadmin_operator;
GRANT UPDATE (applied_at) ON public.club_setting_decisions TO clubadmin_app;
-- Merging duplicate people moves who published or recorded them (person-merge).
GRANT UPDATE (published_by_person_id) ON public.consent_texts TO clubadmin_app;
GRANT UPDATE (recorded_by_person_id) ON public.club_setting_decisions TO clubadmin_app;
REVOKE DELETE ON public.consents FROM clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- The audit log is deleted by age (audit:retention, AUDIT_RETENTION_MONTHS);
-- the club index starts with club_id.
CREATE INDEX events_created_idx ON audit.events (created_at);
--> statement-breakpoint

-- "Remove my contact details now" when leaving (P1.8a): the purge runs as
-- clubadmin_retention in the worker; the leaving transaction queues it for
-- its own club only.
CREATE FUNCTION app.request_club_data_purge(p_person_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF app.current_club_id() IS NULL THEN
    RAISE EXCEPTION 'request_club_data_purge runs in a club' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM graphile_worker.add_job(
    'privacy:purge_member',
    json_build_object('clubId', app.current_club_id(), 'personId', p_person_id),
    job_key := 'privacy:purge_member:' || app.current_club_id()::text || ':' || p_person_id::text,
    max_attempts := 10
  );
END
$$;
REVOKE ALL ON FUNCTION app.request_club_data_purge(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_club_data_purge(uuid) TO clubadmin_app;
--> statement-breakpoint

-- Whether a person has any open relationship to a club: membership, role,
-- group function or ownership, current employment, pending join request,
-- open waiting-list entry, or a registration to a coming event.
CREATE FUNCTION privacy.has_open_relationship(p_club_id uuid, p_person_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (SELECT 1 FROM public.club_memberships m
                 WHERE m.club_id = p_club_id AND m.person_id = p_person_id AND m.valid_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.club_role_assignments r
                 WHERE r.club_id = p_club_id AND r.person_id = p_person_id AND r.valid_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.group_memberships g
                 WHERE g.club_id = p_club_id AND g.person_id = p_person_id AND g.valid_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.group_owners o
                 WHERE o.club_id = p_club_id AND o.person_id = p_person_id AND o.valid_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.employments e
                 WHERE e.club_id = p_club_id AND e.person_id = p_person_id
                   AND (e.ends_on IS NULL OR e.ends_on >= current_date))
      OR EXISTS (SELECT 1 FROM public.join_requests j
                 WHERE j.club_id = p_club_id AND j.person_id = p_person_id AND j.status = 'pending')
      OR EXISTS (SELECT 1 FROM public.group_waitlist_entries w
                 WHERE w.club_id = p_club_id AND w.person_id = p_person_id
                   AND w.status IN ('waiting', 'offered'))
      OR EXISTS (SELECT 1 FROM public.event_registrations r
                 JOIN public.events ev ON ev.club_id = r.club_id AND ev.id = r.event_id
                 WHERE r.club_id = p_club_id AND r.person_id = p_person_id
                   AND r.status IN ('confirmed', 'waitlisted', 'offered') AND ev.ends_at > now())
$$;
REVOKE ALL ON FUNCTION privacy.has_open_relationship(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.has_open_relationship(uuid, uuid) TO clubadmin_retention;
--> statement-breakpoint

-- The former-member purge (P1.8a, docs/gdpr.md "Retention defaults"): once a
-- person has had no open relationship to the club for the club's
-- former_member_retention_months (or at once when they chose "remove now"),
-- the club keeps only minimised facts (member number, membership dates and
-- type, groups and roles). Contact details shared with the club, emergency
-- contacts, the club's notes, consents and free-text notes and answers go,
-- also from the history. Idempotent; a person who rejoined and left again
-- is purged again. Run as clubadmin_retention.
CREATE FUNCTION privacy.purge_former_member(p_club_id uuid, p_person_id uuid, p_now boolean DEFAULT false)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_profile_keys CONSTANT text[] := ARRAY['shared_fields', 'emergency_contacts', 'notes'];
  v_consent_keys CONSTANT text[] := ARRAY['club_note'];
  v_response_keys CONSTANT text[] := ARRAY['note'];
  v_join_keys CONSTANT text[] := ARRAY['message', 'decision_message'];
  v_waitlist_keys CONSTANT text[] := ARRAY['applicant_note', 'owner_note'];
  v_registration_keys CONSTANT text[] := ARRAY['answers', 'sensitive_answers'];
  v_months integer;
  v_last_end timestamptz;
  v_purged_at timestamptz;
BEGIN
  IF privacy.has_open_relationship(p_club_id, p_person_id) THEN
    RETURN false;
  END IF;
  SELECT max(m.valid_to) INTO v_last_end FROM public.club_memberships m
  WHERE m.club_id = p_club_id AND m.person_id = p_person_id AND m.status = 'left';
  IF v_last_end IS NULL THEN
    RETURN false;
  END IF;
  SELECT c.former_member_retention_months INTO v_months FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT p_now AND v_last_end > now() - make_interval(months => v_months) THEN
    RETURN false;
  END IF;
  SELECT p.club_data_purged_at INTO v_purged_at FROM public.club_profiles p
  WHERE p.club_id = p_club_id AND p.person_id = p_person_id;
  IF v_purged_at IS NOT NULL AND v_purged_at >= v_last_end THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.request_id', 'privacy:retention', true);

  UPDATE public.club_profiles
  SET shared_fields = '{}', emergency_contacts = '[]', notes = NULL, club_data_purged_at = now()
  WHERE club_id = p_club_id AND person_id = p_person_id;
  -- History first: the rows below are deleted or changed and their history keeps the values.
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_consent_keys),
      new_values = privacy.scrub(h.new_values, v_consent_keys)
  FROM public.consents c
  WHERE c.club_id = p_club_id AND c.person_id = p_person_id
    AND h.table_name = 'public.consents' AND h.record_id = c.id;
  DELETE FROM public.consents WHERE club_id = p_club_id AND person_id = p_person_id;
  UPDATE public.activity_responses SET note = NULL
  WHERE club_id = p_club_id AND person_id = p_person_id AND note IS NOT NULL;
  UPDATE public.join_requests SET message = NULL, decision_message = NULL
  WHERE club_id = p_club_id AND person_id = p_person_id
    AND (message IS NOT NULL OR decision_message IS NOT NULL);
  UPDATE public.group_waitlist_entries SET applicant_note = NULL, owner_note = NULL
  WHERE club_id = p_club_id AND person_id = p_person_id
    AND (applicant_note IS NOT NULL OR owner_note IS NOT NULL);
  UPDATE public.event_registrations SET answers = '{}', sensitive_answers = NULL
  WHERE club_id = p_club_id AND person_id = p_person_id
    AND (answers <> '{}' OR sensitive_answers IS NOT NULL);

  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_profile_keys),
      new_values = privacy.scrub(h.new_values, v_profile_keys)
  FROM public.club_profiles p
  WHERE p.club_id = p_club_id AND p.person_id = p_person_id
    AND h.table_name = 'public.club_profiles' AND h.record_id = p.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_response_keys),
      new_values = privacy.scrub(h.new_values, v_response_keys)
  FROM public.activity_responses r
  WHERE r.club_id = p_club_id AND r.person_id = p_person_id
    AND h.table_name = 'public.activity_responses' AND h.record_id = r.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_join_keys),
      new_values = privacy.scrub(h.new_values, v_join_keys)
  FROM public.join_requests j
  WHERE j.club_id = p_club_id AND j.person_id = p_person_id
    AND h.table_name = 'public.join_requests' AND h.record_id = j.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_waitlist_keys),
      new_values = privacy.scrub(h.new_values, v_waitlist_keys)
  FROM public.group_waitlist_entries w
  WHERE w.club_id = p_club_id AND w.person_id = p_person_id
    AND h.table_name = 'public.group_waitlist_entries' AND h.record_id = w.id;
  UPDATE history.record_changes h
  SET old_values = privacy.scrub(h.old_values, v_registration_keys),
      new_values = privacy.scrub(h.new_values, v_registration_keys)
  FROM public.event_registrations r
  WHERE r.club_id = p_club_id AND r.person_id = p_person_id
    AND h.table_name = 'public.event_registrations' AND h.record_id = r.id;

  INSERT INTO audit.events (club_id, actor_kind, action, resource_type, resource_id, changed_fields, request_id)
  VALUES (p_club_id, 'system_job', 'person.club_data.purged', 'person', p_person_id,
    v_profile_keys || ARRAY['consents'], current_setting('app.request_id', true));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION privacy.purge_former_member(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.purge_former_member(uuid, uuid, boolean) TO clubadmin_retention;
--> statement-breakpoint

-- Orphaned people (P1.8a): a person without a login, not yet erased, with no
-- open relationship to any club, every club profile purged and no open
-- guardianship. They are kept ORPHAN_RETENTION_MONTHS in case a club or a
-- guardian links them again, then erased. Accounts with a login are never
-- orphans.
CREATE FUNCTION privacy.is_orphan(p_person_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.people p
    WHERE p.id = p_person_id AND p.anonymized_at IS NULL AND p.merged_into_person_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM public.club_profiles c
                      WHERE c.person_id = p.id AND c.club_data_purged_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public.club_profiles c
                      WHERE c.person_id = p.id AND privacy.has_open_relationship(c.club_id, p.id))
      AND NOT EXISTS (SELECT 1 FROM public.guardianships g
                      WHERE (g.ward_person_id = p.id OR g.guardian_person_id = p.id)
                        AND g.valid_to IS NULL))
$$;
REVOKE ALL ON FUNCTION privacy.is_orphan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.is_orphan(uuid) TO clubadmin_retention;

-- Marks or clears one person's orphaned_since; returns the value now set.
CREATE FUNCTION privacy.mark_orphan(p_person_id uuid) RETURNS timestamptz
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_orphan boolean := privacy.is_orphan(p_person_id);
  v_since timestamptz;
BEGIN
  PERFORM set_config('app.actor_kind', 'system_job', true);
  PERFORM set_config('app.request_id', 'privacy:retention', true);
  UPDATE public.people
  SET orphaned_since = CASE WHEN v_orphan THEN coalesce(orphaned_since, now()) END
  WHERE id = p_person_id
    AND (orphaned_since IS NULL) = v_orphan
  RETURNING orphaned_since INTO v_since;
  IF NOT FOUND THEN
    SELECT orphaned_since INTO v_since FROM public.people WHERE id = p_person_id;
  END IF;
  RETURN v_since;
END
$$;
REVOKE ALL ON FUNCTION privacy.mark_orphan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy.mark_orphan(uuid) TO clubadmin_retention;
--> statement-breakpoint

-- Erasure (P0.11, replaced in 0012, 0015, 0017): additionally clears join
-- request and waiting-list notes, guardianship notes, the invitations sent
-- to the person's address (club invitations and unaccepted guardian
-- invitations), and revokes open consents.
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
GRANT UPDATE ON public.join_requests, public.group_waitlist_entries, public.guardianships,
  public.invitations, public.consents TO clubadmin_retention;
GRANT DELETE ON public.consents TO clubadmin_retention;
--> statement-breakpoint

-- Ledger entries whose person still has personal data (P0.11; now also the
-- free text of P1.8a and open consents).
CREATE OR REPLACE FUNCTION privacy.unerased_people() RETURNS TABLE (person_id uuid)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT l.person_id
  FROM privacy.deletion_ledger l
  JOIN public.people p ON p.id = l.person_id
  WHERE p.anonymized_at IS NULL OR p.given_name <> '' OR p.family_name <> ''
     OR p.personal_identity_number IS NOT NULL OR p.phone IS NOT NULL OR p.address IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.accounts a
                WHERE a.person_id = l.person_id AND a.email <> 'erased-' || l.person_id || '@erased.invalid')
     OR EXISTS (SELECT 1 FROM public.club_profiles c
                WHERE c.person_id = l.person_id AND (c.emergency_contacts <> '[]' OR c.notes IS NOT NULL))
     OR EXISTS (SELECT 1 FROM public.join_requests j
                WHERE j.person_id = l.person_id AND (j.message IS NOT NULL OR j.decision_message IS NOT NULL))
     OR EXISTS (SELECT 1 FROM public.group_waitlist_entries w
                WHERE w.person_id = l.person_id AND (w.applicant_note IS NOT NULL OR w.owner_note IS NOT NULL))
     OR EXISTS (SELECT 1 FROM public.guardianships g
                WHERE (g.ward_person_id = l.person_id OR g.guardian_person_id = l.person_id)
                  AND (g.consent_note IS NOT NULL OR g.ended_reason IS NOT NULL))
     OR EXISTS (SELECT 1 FROM public.consents c
                WHERE c.person_id = l.person_id AND (c.revoked_at IS NULL OR c.club_note IS NOT NULL))
$$;
--> statement-breakpoint

-- Applies a recorded board decision (P1.8a, ADR 0037): writes the decided
-- settings to the club, marks the decision applied and publishes the next
-- version of the club's privacy policy (a snapshot of the values it shows).
-- The first time, the policy as it was before is recorded as version 1 (the
-- defaults, no decision). Run in the club's tenant or system transaction by
-- the API (effective today) and the worker (clubs:apply_decisions); the
-- values were validated against the settings registry when recorded.
-- Returns the new policy's ID, or NULL when the decision was applied before.
CREATE FUNCTION app.policy_settings(p_club public.clubs) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT jsonb_build_object(
    'former_member_retention_months', p_club.former_member_retention_months,
    'attendance_retention_months', p_club.attendance_retention_months,
    'consent_purposes', to_jsonb(p_club.consent_purposes),
    'consent_reconfirm_on_new_version', p_club.consent_reconfirm_on_new_version,
    'privacy_contact_email', p_club.privacy_contact_email)
$$;

CREATE FUNCTION app.apply_setting_decision(p_decision_id uuid, p_template_version integer)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_decision public.club_setting_decisions;
  v_club public.clubs;
  v_settings jsonb;
  v_policy uuid;
BEGIN
  SELECT * INTO v_decision FROM public.club_setting_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.applied_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_club FROM public.clubs WHERE id = v_decision.club_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.club_privacy_policies WHERE club_id = v_club.id) THEN
    INSERT INTO public.club_privacy_policies (club_id, version, template_version, settings, effective_from)
    VALUES (v_club.id, 1, p_template_version, app.policy_settings(v_club), v_club.created_at::date);
  END IF;
  v_settings := v_decision.settings;
  UPDATE public.clubs SET
    former_member_retention_months = coalesce(
      (v_settings ->> 'former_member_retention_months')::integer, former_member_retention_months),
    attendance_retention_months = coalesce(
      (v_settings ->> 'attendance_retention_months')::integer, attendance_retention_months),
    consent_purposes = CASE WHEN v_settings ? 'consent_purposes'
      THEN ARRAY(SELECT jsonb_array_elements_text(v_settings -> 'consent_purposes'))
      ELSE consent_purposes END,
    consent_reconfirm_on_new_version = coalesce(
      (v_settings ->> 'consent_reconfirm_on_new_version')::boolean, consent_reconfirm_on_new_version)
  WHERE id = v_club.id
  RETURNING * INTO v_club;
  UPDATE public.club_setting_decisions SET applied_at = now() WHERE id = p_decision_id;
  INSERT INTO public.club_privacy_policies
    (club_id, version, template_version, settings, decision_id, effective_from)
  SELECT v_club.id, coalesce(max(version), 0) + 1, p_template_version, app.policy_settings(v_club),
    p_decision_id, v_decision.effective_from
  FROM public.club_privacy_policies WHERE club_id = v_club.id
  RETURNING id INTO v_policy;
  RETURN v_policy;
END
$$;
REVOKE ALL ON FUNCTION app.apply_setting_decision(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_setting_decision(uuid, integer) TO clubadmin_app;
GRANT EXECUTE ON FUNCTION app.policy_settings(public.clubs) TO clubadmin_app;
