CREATE TABLE "activity_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"responded_by_person_id" uuid NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_responses_unique" UNIQUE("activity_id","person_id"),
	CONSTRAINT "activity_responses_status" CHECK ("activity_responses"."status" IN ('attending', 'not_attending')),
	CONSTRAINT "activity_responses_note" CHECK ("activity_responses"."note" IS NULL OR length("activity_responses"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"guest" boolean DEFAULT false NOT NULL,
	"recorded_by_person_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_records_unique" UNIQUE("activity_id","person_id"),
	CONSTRAINT "attendance_records_status" CHECK ("attendance_records"."status" IN ('present', 'absent', 'excused')),
	CONSTRAINT "attendance_records_role" CHECK ("attendance_records"."role" IN ('participant', 'leader'))
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "response_mode" text DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_series" ADD COLUMN "response_mode" text DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_series" ADD COLUMN "respond_by_minutes" integer;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "response_mode" text DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "respond_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "attendance_lock_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_responses" ADD CONSTRAINT "activity_responses_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_responses" ADD CONSTRAINT "activity_responses_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_responses" ADD CONSTRAINT "activity_responses_responded_by_person_id_people_id_fk" FOREIGN KEY ("responded_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_responses" ADD CONSTRAINT "activity_responses_activity_fk" FOREIGN KEY ("club_id","activity_id") REFERENCES "public"."activities"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_recorded_by_person_id_people_id_fk" FOREIGN KEY ("recorded_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_activity_fk" FOREIGN KEY ("club_id","activity_id") REFERENCES "public"."activities"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_responses_activity_idx" ON "activity_responses" USING btree ("club_id","activity_id");--> statement-breakpoint
CREATE INDEX "activity_responses_person_idx" ON "activity_responses" USING btree ("person_id","activity_id");--> statement-breakpoint
CREATE INDEX "activity_responses_responder_idx" ON "activity_responses" USING btree ("responded_by_person_id");--> statement-breakpoint
CREATE INDEX "attendance_records_activity_idx" ON "attendance_records" USING btree ("club_id","activity_id");--> statement-breakpoint
CREATE INDEX "attendance_records_person_idx" ON "attendance_records" USING btree ("club_id","person_id","activity_id");--> statement-breakpoint
CREATE INDEX "attendance_records_recorder_idx" ON "attendance_records" USING btree ("recorded_by_person_id");--> statement-breakpoint
CREATE INDEX "group_memberships_group_period_idx" ON "group_memberships" USING btree ("group_id","valid_from");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_response_mode" CHECK ("activities"."response_mode" IN ('none', 'optional', 'requested'));--> statement-breakpoint
ALTER TABLE "activity_series" ADD CONSTRAINT "activity_series_response_mode" CHECK ("activity_series"."response_mode" IN ('none', 'optional', 'requested'));--> statement-breakpoint
ALTER TABLE "activity_series" ADD CONSTRAINT "activity_series_respond_by_minutes" CHECK ("activity_series"."respond_by_minutes" IS NULL OR "activity_series"."respond_by_minutes" BETWEEN 0 AND 20160);--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_attendance_lock_days" CHECK ("clubs"."attendance_lock_days" BETWEEN 1 AND 365);--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.5, ADR 0035): responses and attendance.
-------------------------------------------------------------------------------

-- Existing activities and series get the mode of their kind (matches and
-- meetings ask for answers, "other" does not); the calendars' read model
-- follows.
UPDATE public.activities SET response_mode = CASE kind
  WHEN 'training' THEN 'optional' WHEN 'other' THEN 'none' ELSE 'requested' END
WHERE response_mode <> CASE kind
  WHEN 'training' THEN 'optional' WHEN 'other' THEN 'none' ELSE 'requested' END;
UPDATE public.activity_series SET response_mode = CASE kind
  WHEN 'training' THEN 'optional' WHEN 'other' THEN 'none' ELSE 'requested' END
WHERE response_mode <> CASE kind
  WHEN 'training' THEN 'optional' WHEN 'other' THEN 'none' ELSE 'requested' END;
UPDATE public.schedule_entries se SET response_mode = a.response_mode
FROM public.activities a WHERE a.id = se.activity_id AND se.response_mode <> a.response_mode;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.activity_responses'),
  app.enable_updated_at('public.activity_responses'),
  history.enable_history('public.activity_responses');
SELECT app.enable_tenant_rls('public.attendance_records'),
  app.enable_updated_at('public.attendance_records'),
  history.enable_history('public.attendance_records');
-- Attendance is corrected, never deleted (grant reports refer to it).
REVOKE DELETE ON public.attendance_records FROM clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- "My schedule" shows my and my wards' answers across clubs (the service
-- decides whose; the same path as schedule_entries' member_read).
CREATE POLICY own_read ON public.activity_responses FOR SELECT
  USING (person_id = ANY ((SELECT app.self_and_wards())::uuid[]));
--> statement-breakpoint

-- Erasure (docs/gdpr.md) also removes the notes on the person's answers.
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

  IF v_changed THEN
    INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, changed_fields, request_id)
    VALUES ('system_job', 'person.erased', 'person', p_person_id, v_people_keys,
      current_setting('app.request_id', true));
  END IF;
  RETURN v_changed;
END
$$;

GRANT UPDATE ON public.activity_responses TO clubadmin_retention;
