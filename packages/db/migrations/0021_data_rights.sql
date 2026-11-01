CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_person_id" uuid NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"object_key" text,
	"size_bytes" bigint,
	"locale" text NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_exports_status" CHECK ("data_exports"."status" IN ('queued', 'ready', 'failed', 'expired')),
	CONSTRAINT "data_exports_ready" CHECK ("data_exports"."status" <> 'ready' OR ("data_exports"."object_key" IS NOT NULL AND "data_exports"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"include_ward_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cancelled_by_person_id" uuid,
	"cancelled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"pending_idp_subject" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_requests_kind" CHECK ("erasure_requests"."kind" IN ('account_deletion', 'ward_erasure')),
	CONSTRAINT "erasure_requests_status" CHECK ("erasure_requests"."status" IN ('scheduled', 'cancelled', 'running', 'done', 'failed')),
	CONSTRAINT "erasure_requests_wards" CHECK ("erasure_requests"."kind" = 'account_deletion' OR cardinality("erasure_requests"."include_ward_ids") = 0)
);
--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_subject_person_id_people_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_cancelled_by_person_id_people_id_fk" FOREIGN KEY ("cancelled_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_exports_requester_idx" ON "data_exports" USING btree ("requested_by_person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "data_exports_subject_idx" ON "data_exports" USING btree ("subject_person_id");--> statement-breakpoint
CREATE INDEX "data_exports_open_idx" ON "data_exports" USING btree ("expires_at") WHERE "data_exports"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "data_exports_queued_idx" ON "data_exports" USING btree ("created_at") WHERE "data_exports"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_requests_open_unique" ON "erasure_requests" USING btree ("person_id") WHERE "erasure_requests"."status" IN ('scheduled', 'running');--> statement-breakpoint
CREATE INDEX "erasure_requests_due_idx" ON "erasure_requests" USING btree ("scheduled_for") WHERE "erasure_requests"."status" IN ('scheduled', 'running');--> statement-breakpoint
CREATE INDEX "erasure_requests_requester_idx" ON "erasure_requests" USING btree ("requested_by_person_id");--> statement-breakpoint
CREATE INDEX "erasure_requests_done_idx" ON "erasure_requests" USING btree ("done_at") WHERE "erasure_requests"."done_at" IS NOT NULL;--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.8b, ADR 0041): "download my data", account deletion
-- and ward erasure.
-------------------------------------------------------------------------------

-- Global tables with row-level security (ADR 0023): the requester for self
-- or a ward they are a full guardian of; the system (the jobs in the API and
-- the worker); retention deletes old rows and erases. Rows are never deleted
-- by the application.
ALTER TABLE public.data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY requester_read ON public.data_exports FOR SELECT
  USING (requested_by_person_id = app.current_person_id());
CREATE POLICY requester_insert ON public.data_exports FOR INSERT
  WITH CHECK (requested_by_person_id = app.current_person_id() AND status = 'queued'
    AND (subject_person_id = app.current_person_id() OR app.is_full_guardian_of(subject_person_id)));
CREATE POLICY system_access ON public.data_exports
  USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY retention_access ON public.data_exports TO clubadmin_retention USING (true) WITH CHECK (true);
REVOKE DELETE ON public.data_exports FROM clubadmin_app, clubadmin_operator;
GRANT UPDATE, DELETE ON public.data_exports TO clubadmin_retention;
SELECT app.enable_updated_at('public.data_exports'),
  history.enable_history('public.data_exports');
--> statement-breakpoint

-- The person, the requester and the person's full guardians see a request;
-- the person or a full guardian creates and cancels it; the jobs run it.
ALTER TABLE public.erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erasure_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY concerned_access ON public.erasure_requests
  USING (person_id = app.current_person_id() OR requested_by_person_id = app.current_person_id()
    OR app.is_full_guardian_of(person_id))
  WITH CHECK (status IN ('scheduled', 'cancelled')
    AND (person_id = app.current_person_id() OR app.is_full_guardian_of(person_id)));
CREATE POLICY system_access ON public.erasure_requests
  USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY retention_access ON public.erasure_requests TO clubadmin_retention USING (true) WITH CHECK (true);
REVOKE DELETE ON public.erasure_requests FROM clubadmin_app, clubadmin_operator;
GRANT UPDATE, DELETE ON public.erasure_requests TO clubadmin_retention;
SELECT app.enable_updated_at('public.erasure_requests'),
  history.enable_history('public.erasure_requests');
--> statement-breakpoint

-- A requested export becomes a job in the same transaction (like member
-- exports): the API's job runner writes the file outside the request.
CREATE FUNCTION app.enqueue_data_export() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'privacy:export',
    json_build_object('exportId', NEW.id),
    job_key := 'privacy:export:' || NEW.id::text,
    max_attempts := 3
  );
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.enqueue_data_export() FROM PUBLIC;
CREATE TRIGGER enqueue_export AFTER INSERT ON public.data_exports
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_data_export();
--> statement-breakpoint

-- erase_person v6: also the person's "download my data" requests.
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
     OR EXISTS (SELECT 1 FROM public.data_exports x
                WHERE x.subject_person_id = l.person_id OR x.requested_by_person_id = l.person_id)
     OR EXISTS (SELECT 1 FROM public.consents c
                WHERE c.person_id = l.person_id AND (c.revoked_at IS NULL OR c.club_note IS NOT NULL))
$$;
--> statement-breakpoint

-- What stands in the way of erasing people (P1.8b): their open memberships
-- (whose clubs may have invoices), club roles (with whether they are the
-- club's last manager), leader functions and group ownerships, in every
-- club, in one statement. Only for the caller and their wards (or the
-- system); IDs and the names of clubs and groups only.
CREATE FUNCTION app.erasure_assignments(p_people uuid[])
  RETURNS TABLE (person_id uuid, club_id uuid, club_name text, kind text, assignment_id uuid,
                 role text, group_id uuid, group_name text, group_function text,
                 last_manager boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  -- Names by primary key (scalar subqueries): a join would let the planner
  -- scan clubs and groups under their row-level security filters.
  WITH people AS (
    SELECT p FROM unnest(p_people) p
    WHERE app.is_system() OR p = ANY ((SELECT app.self_and_wards())::uuid[])),
  facts AS (
    SELECT m.person_id, m.club_id, 'membership'::text AS kind, m.id, NULL::text AS role,
      NULL::uuid AS group_id, NULL::text AS group_function, false AS last_manager
    FROM public.club_memberships m
    WHERE m.person_id IN (SELECT p FROM people) AND m.valid_to IS NULL
    UNION ALL
    SELECT r.person_id, r.club_id, 'role', r.id, r.role, NULL, NULL,
      r.role = 'club_manager' AND NOT EXISTS (
        SELECT 1 FROM public.club_role_assignments o
        WHERE o.club_id = r.club_id AND o.role = 'club_manager' AND o.valid_to IS NULL
          AND o.person_id <> r.person_id)
    FROM public.club_role_assignments r
    WHERE r.person_id IN (SELECT p FROM people) AND r.valid_to IS NULL
    UNION ALL
    SELECT g.person_id, g.club_id, 'group_function', g.id, NULL, g.group_id, g.function, false
    FROM public.group_memberships g
    WHERE g.person_id IN (SELECT p FROM people) AND g.valid_to IS NULL AND g.function <> 'member'
    UNION ALL
    SELECT o.person_id, o.club_id, 'group_owner', o.id, NULL, o.group_id, NULL, false
    FROM public.group_owners o
    WHERE o.person_id IN (SELECT p FROM people) AND o.valid_to IS NULL)
  SELECT f.person_id, f.club_id, (SELECT c.name FROM public.clubs c WHERE c.id = f.club_id),
    f.kind, f.id, f.role, f.group_id,
    (SELECT gr.name FROM public.groups gr WHERE gr.id = f.group_id), f.group_function,
    f.last_manager
  FROM facts f
$$;
REVOKE ALL ON FUNCTION app.erasure_assignments(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erasure_assignments(uuid[]) TO clubadmin_app, clubadmin_retention;
--> statement-breakpoint

-- The caller's wards (full guardianship) with whether they have a login (an
-- account of a person not erased) and
-- their other full guardians: who has one, and how many have a login
-- (P1.8b: wards erased with an account, notices to co-guardians). Accounts
-- are otherwise only visible to their owner. For the caller (or the
-- system, for any guardian).
CREATE FUNCTION app.ward_logins(p_guardian uuid)
  RETURNS TABLE (ward_person_id uuid, ward_has_login boolean, other_guardian_ids uuid[],
                 other_guardians_with_login integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  -- Each lookup by key (accounts by person, people by primary key): joins
  -- would let the planner scan people and accounts under their policies.
  WITH wards AS (
    SELECT g.ward_person_id
    FROM public.guardianships g
    WHERE g.guardian_person_id = p_guardian
      AND (app.is_system() OR p_guardian = app.current_person_id())
      AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active' AND g.valid_to IS NULL),
  others AS (
    SELECT w.ward_person_id, o.guardian_person_id,
      EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = o.guardian_person_id)
        AND (SELECT p.anonymized_at FROM public.people p WHERE p.id = o.guardian_person_id)
          IS NULL AS has_login
    FROM wards w
    JOIN public.guardianships o ON o.ward_person_id = w.ward_person_id
    WHERE o.guardian_person_id <> p_guardian
      AND o.kind IN ('parent', 'legal_guardian') AND o.status = 'active' AND o.valid_to IS NULL)
  SELECT w.ward_person_id,
    EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = w.ward_person_id)
      AND (SELECT p.anonymized_at FROM public.people p WHERE p.id = w.ward_person_id) IS NULL,
    coalesce((SELECT array_agg(o.guardian_person_id ORDER BY o.guardian_person_id)
              FROM others o WHERE o.ward_person_id = w.ward_person_id), '{}'),
    (SELECT count(*)::int FROM others o
     WHERE o.ward_person_id = w.ward_person_id AND o.has_login)
  FROM wards w
$$;
REVOKE ALL ON FUNCTION app.ward_logins(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ward_logins(uuid) TO clubadmin_app, clubadmin_retention;
