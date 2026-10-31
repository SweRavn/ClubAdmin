CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"push_device_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"digest" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_ref" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel" CHECK ("notification_deliveries"."channel" IN ('email', 'push')),
	CONSTRAINT "notification_deliveries_status" CHECK ("notification_deliveries"."status" IN ('queued', 'held', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient_person_id" uuid NOT NULL,
	"club_id" uuid,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"about_person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_unique" UNIQUE("recipient_person_id","dedupe_key"),
	CONSTRAINT "notifications_category" CHECK ("notifications"."category" IN ('schedule', 'responses', 'leader', 'events', 'membership', 'club_admin', 'family', 'account', 'waitlist')),
	CONSTRAINT "notifications_about" CHECK (cardinality("notifications"."about_person_ids") <= 10)
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_sealed" text NOT NULL,
	"provider" text DEFAULT 'expo' NOT NULL,
	"platform" text NOT NULL,
	"app_variant" text DEFAULT 'production' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_token_unique" UNIQUE("token_hash"),
	CONSTRAINT "push_devices_platform" CHECK ("push_devices"."platform" IN ('ios', 'android')),
	CONSTRAINT "push_devices_provider" CHECK ("push_devices"."provider" IN ('expo'))
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_push_device_id_push_devices_id_fk" FOREIGN KEY ("push_device_id") REFERENCES "public"."push_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_person_id_people_id_fk" FOREIGN KEY ("recipient_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("send_after") WHERE "notification_deliveries"."status" IN ('queued', 'held');--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_idx" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_receipts_idx" ON "notification_deliveries" USING btree ("sent_at") WHERE "notification_deliveries"."channel" = 'push' AND "notification_deliveries"."status" = 'sent' AND "notification_deliveries"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("recipient_person_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_person_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_about_idx" ON "notifications" USING gin ("about_person_ids");--> statement-breakpoint
CREATE INDEX "push_devices_account_idx" ON "push_devices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "activities_reminder_idx" ON "activities" USING btree (coalesce("respond_by", "starts_at")) WHERE "activities"."response_mode" = 'requested' AND "activities"."status" = 'scheduled';

--> statement-breakpoint

-- Hand-written (P1.7, ADR 0039). Recipient-owned global tables (ADR 0023):
-- RLS enabled, not forced, like people and accounts. The worker writes in
-- system context; people read their own inbox and mark it read (read_at
-- only); devices belong to the account.
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_read ON public.notifications FOR SELECT
  USING (app.is_system() OR recipient_person_id = app.current_person_id());
CREATE POLICY own_update ON public.notifications FOR UPDATE
  USING (recipient_person_id = app.current_person_id())
  WITH CHECK (recipient_person_id = app.current_person_id());
CREATE POLICY system_write ON public.notifications FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY system_delete ON public.notifications FOR DELETE USING (app.is_system());
CREATE POLICY system_update ON public.notifications FOR UPDATE
  USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY retention_access ON public.notifications TO clubadmin_retention USING (true) WITH CHECK (true);
REVOKE UPDATE ON public.notifications FROM clubadmin_app, clubadmin_operator;
GRANT UPDATE (read_at, about_person_ids) ON public.notifications TO clubadmin_app;
-- Inserts are the bulk of the table: history records changes and deletions only.
SELECT app.enable_updated_at('public.notifications'),
  history.enable_history('public.notifications', skip_insert => true);
--> statement-breakpoint

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_access ON public.notification_deliveries
  USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY retention_access ON public.notification_deliveries TO clubadmin_retention USING (true) WITH CHECK (true);
SELECT app.enable_updated_at('public.notification_deliveries');
--> statement-breakpoint

ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_devices ON public.push_devices
  USING (app.is_system() OR account_id IN (
    SELECT a.id FROM public.accounts a WHERE a.person_id = app.current_person_id()))
  WITH CHECK (app.is_system() OR account_id IN (
    SELECT a.id FROM public.accounts a WHERE a.person_id = app.current_person_id()));
CREATE POLICY retention_access ON public.push_devices TO clubadmin_retention USING (true) WITH CHECK (true);
SELECT app.enable_updated_at('public.push_devices'),
  history.enable_history('public.push_devices', redact => ARRAY['token_sealed', 'token_hash'],
    ignore => ARRAY['last_seen_at']);
--> statement-breakpoint

GRANT UPDATE, DELETE ON public.notifications, public.notification_deliveries, public.push_devices
  TO clubadmin_retention;
--> statement-breakpoint

-- Registering a phone for push (P1.7): the token moves to the caller's
-- account when another account had it (the phone changed hands, or someone
-- else logged in on it). Device rows of other accounts are not visible to
-- the caller, so this is its own access path; it acts only for the caller.
CREATE FUNCTION app.claim_push_device(p_token_hash text, p_token_sealed text, p_platform text, p_app_variant text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_account uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_account FROM public.accounts WHERE person_id = app.current_person_id();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'no account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.push_devices (account_id, token_hash, token_sealed, platform, app_variant)
  VALUES (v_account, p_token_hash, p_token_sealed, p_platform, p_app_variant)
  ON CONFLICT (token_hash) DO UPDATE
    SET account_id = EXCLUDED.account_id, token_sealed = EXCLUDED.token_sealed,
        platform = EXCLUDED.platform, app_variant = EXCLUDED.app_variant,
        last_seen_at = now(), disabled_at = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION app.claim_push_device(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_push_device(text, text, text, text) TO clubadmin_app;
--> statement-breakpoint

-- The address an account had before its last email change (P1.7): the
-- worker tells the old address. Record history of global tables is not
-- readable by the app role (P0.7); this is its own access path, for the
-- system context only, and returns nothing else.
CREATE FUNCTION app.previous_account_email(p_account_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT h.old_values ->> 'email' FROM history.record_changes h
  WHERE app.is_system() AND h.table_name = 'public.accounts' AND h.record_id = p_account_id
    AND h.operation = 'UPDATE' AND 'email' = ANY (h.changed_columns)
  ORDER BY h.changed_at DESC, h.id DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.previous_account_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.previous_account_email(uuid) TO clubadmin_app;
--> statement-breakpoint

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
