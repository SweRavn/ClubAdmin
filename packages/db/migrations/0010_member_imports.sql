CREATE TABLE "member_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"club_id" uuid NOT NULL,
	"cells" text NOT NULL,
	"data" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"issues" text[] DEFAULT '{}' NOT NULL,
	"family_key" text,
	"match_person_id" uuid,
	"resolution" text,
	"skipped_by_user" boolean DEFAULT false NOT NULL,
	"person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_import_rows_status" CHECK ("member_import_rows"."status" IN ('new', 'duplicate', 'error', 'skipped', 'imported')),
	CONSTRAINT "member_import_rows_issues" CHECK ("member_import_rows"."issues" <@ ARRAY['name_missing', 'birth_date_missing', 'birth_date_invalid', 'birth_date_in_future', 'personal_identity_number_invalid', 'personal_identity_number_mismatch', 'gender_invalid', 'phone_invalid', 'email_invalid', 'address_incomplete', 'membership_type_invalid', 'start_date_invalid', 'member_number_invalid', 'member_number_taken', 'member_number_repeated', 'group_not_found', 'guardian_name_missing', 'guardian_kind_invalid', 'guardian_phone_invalid', 'guardian_email_invalid', 'guardian_consent_note_missing', 'relation_invalid', 'family_without_member', 'repeated_in_file', 'import_failed', 'minor_email_moved', 'minor_email_dropped', 'protected_address_dropped', 'already_in_club', 'possible_duplicate', 'guardian_is_member', 'unknown_columns']::text[]),
	CONSTRAINT "member_import_rows_resolution" CHECK ("member_import_rows"."resolution" IS NULL OR "member_import_rows"."resolution" IN ('same_person', 'different_person'))
);
--> statement-breakpoint
CREATE TABLE "member_imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"source_format" text DEFAULT 'csv' NOT NULL,
	"detected_source" text,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"counts" jsonb DEFAULT '{"rows":0,"new":0,"duplicate":0,"error":0,"skipped":0,"imported":0,"guardians":0,"invitations":0}'::jsonb NOT NULL,
	"object_key" text,
	"error_code" text,
	"confirmed_by_person_id" uuid,
	"confirmed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_imports_status" CHECK ("member_imports"."status" IN ('uploaded', 'parsing', 'review', 'importing', 'done', 'failed', 'cancelled')),
	CONSTRAINT "member_imports_format" CHECK ("member_imports"."source_format" IN ('csv', 'xlsx'))
);
--> statement-breakpoint
ALTER TABLE "guardian_invitations" DROP CONSTRAINT "guardian_invitations_kind";--> statement-breakpoint
ALTER TABLE "guardianships" DROP CONSTRAINT "guardianships_kind";--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD COLUMN "club_id" uuid;--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD COLUMN "consent_note" text;--> statement-breakpoint
ALTER TABLE "member_import_rows" ADD CONSTRAINT "member_import_rows_import_id_member_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."member_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_import_rows" ADD CONSTRAINT "member_import_rows_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_imports" ADD CONSTRAINT "member_imports_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_imports" ADD CONSTRAINT "member_imports_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_imports" ADD CONSTRAINT "member_imports_confirmed_by_person_id_people_id_fk" FOREIGN KEY ("confirmed_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_import_rows_row_unique" ON "member_import_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "member_import_rows_status_idx" ON "member_import_rows" USING btree ("import_id","status","row_number");--> statement-breakpoint
CREATE INDEX "member_imports_club_idx" ON "member_imports" USING btree ("club_id","id");--> statement-breakpoint
CREATE INDEX "member_imports_creator_idx" ON "member_imports" USING btree ("created_by_person_id");--> statement-breakpoint
CREATE INDEX "member_imports_confirmer_idx" ON "member_imports" USING btree ("confirmed_by_person_id");--> statement-breakpoint
CREATE INDEX "member_imports_purge_idx" ON "member_imports" USING btree ("updated_at") WHERE "member_imports"."purged_at" IS NULL AND "member_imports"."status" IN ('done', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "guardian_invitations_club_idx" ON "guardian_invitations" USING btree ("club_id");--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD CONSTRAINT "guardian_invitations_kind" CHECK ("guardian_invitations"."kind" IN ('parent', 'legal_guardian', 'relative', 'contact_person', 'step_parent', 'foster_parent'));--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_kind" CHECK ("guardianships"."kind" IN ('parent', 'legal_guardian', 'relative', 'contact_person', 'step_parent', 'foster_parent'));--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.3b): adding and importing members, step and foster
-- parents.
-------------------------------------------------------------------------------

-- Invitations sent by a club name the club; clubs are defined after people.
ALTER TABLE public.guardian_invitations ADD CONSTRAINT guardian_invitations_club_id_clubs_id_fk
  FOREIGN KEY (club_id) REFERENCES public.clubs(id);
--> statement-breakpoint

-- The club's administrators see (and resend or revoke) the invitations their
-- club sent, not only the registrar who sent them.
DROP POLICY invitation_access ON public.guardian_invitations;
CREATE POLICY invitation_access ON public.guardian_invitations
  USING (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
    OR (club_id IS NOT NULL AND club_id = app.current_club_id()
      AND app.has_club_role(ARRAY['club_manager', 'registrar']))
  )
  WITH CHECK (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
    OR (club_id IS NOT NULL AND club_id = app.current_club_id()
      AND app.has_club_role(ARRAY['club_manager', 'registrar']))
  );
--> statement-breakpoint

-- Imports: the import is a record that stays (counts only once purged);
-- staging rows hold the file's values and are deleted seven days after the
-- import ends (no record history: listed in history-exclusions.ts). The
-- headers and samples of the file are redacted in the history.
SELECT app.enable_tenant_rls('public.member_imports'),
  app.enable_updated_at('public.member_imports'),
  history.enable_history('public.member_imports', redact => ARRAY['columns'], ignore => ARRAY['counts']);
REVOKE DELETE ON public.member_imports FROM clubadmin_app, clubadmin_operator;
-- The purge job finds ended imports across clubs (IDs only), then works on
-- each in its club's context.
CREATE POLICY system_read ON public.member_imports FOR SELECT USING (app.is_system());
SELECT app.enable_tenant_rls('public.member_import_rows'),
  app.enable_updated_at('public.member_import_rows');
--> statement-breakpoint

-- Parsing and importing run as jobs (members:import_parse, members:import_run;
-- ADR 0033): queued in the same transaction as the status change, like the
-- outbox. A new parse replaces a queued one (the job key).
CREATE FUNCTION app.enqueue_member_import() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status = 'parsing' THEN
    PERFORM graphile_worker.add_job(
      'members:import_parse',
      json_build_object('importId', NEW.id, 'clubId', NEW.club_id),
      job_key := 'members:import_parse:' || NEW.id::text,
      max_attempts := 3
    );
  ELSIF NEW.status = 'importing' THEN
    PERFORM graphile_worker.add_job(
      'members:import_run',
      json_build_object('importId', NEW.id, 'clubId', NEW.club_id),
      job_key := 'members:import_run:' || NEW.id::text,
      max_attempts := 3
    );
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.enqueue_member_import() FROM PUBLIC;
CREATE TRIGGER enqueue_import AFTER UPDATE OF status ON public.member_imports
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.enqueue_member_import();
--> statement-breakpoint

-- Member numbers kept from an imported file: the running number continues
-- after the highest one, so assigned numbers never collide with them.
CREATE OR REPLACE FUNCTION app.assign_member_number() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.member_number IS NULL THEN
    UPDATE public.clubs SET next_member_number = next_member_number + 1
      WHERE id = NEW.club_id
      RETURNING next_member_number - 1 INTO NEW.member_number;
    IF NEW.member_number IS NULL THEN
      RAISE EXCEPTION 'club % not found in the current context', NEW.club_id USING ERRCODE = '23503';
    END IF;
  ELSE
    UPDATE public.clubs SET next_member_number = NEW.member_number + 1
      WHERE id = NEW.club_id AND next_member_number <= NEW.member_number;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Accepting: every linked kind (relatives, contact persons, step and foster
-- parents) records who granted its rights; an invitation sent by a club
-- records the guardianship as the club's, with its consent note.
CREATE OR REPLACE FUNCTION app.accept_guardian_invitation(p_token_hash text, p_email text)
  RETURNS TABLE (status text, guardianship_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_me uuid := app.current_person_id();
  v_invitation public.guardian_invitations;
  v_guardianship uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'accepting an invitation requires a person' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invitation FROM public.guardian_invitations
    WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_invitation.accepted_at IS NOT NULL OR v_invitation.revoked_at IS NOT NULL
     OR v_invitation.expires_at <= now() OR v_invitation.ward_person_id = v_me THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_invitation.email <> lower(btrim(p_email)) THEN
    RETURN QUERY SELECT 'email_mismatch'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT g.id INTO v_guardianship FROM public.guardianships g
    WHERE g.guardian_person_id = v_me AND g.ward_person_id = v_invitation.ward_person_id AND g.valid_to IS NULL;
  IF v_guardianship IS NOT NULL THEN
    RETURN QUERY SELECT 'exists'::text, v_guardianship;
    RETURN;
  END IF;
  INSERT INTO public.guardianships
    (guardian_person_id, ward_person_id, kind, rights, status, created_by_person_id,
     granted_by_person_id, recorded_by_club_id, consent_note)
  VALUES (v_me, v_invitation.ward_person_id, v_invitation.kind, v_invitation.rights, 'active',
    v_invitation.invited_by_person_id,
    CASE WHEN v_invitation.kind NOT IN ('parent', 'legal_guardian') THEN v_invitation.invited_by_person_id END,
    v_invitation.club_id,
    CASE WHEN v_invitation.kind NOT IN ('parent', 'legal_guardian') THEN v_invitation.consent_note END)
  RETURNING id INTO v_guardianship;
  UPDATE public.guardian_invitations
    SET accepted_at = now(), accepted_by_person_id = v_me, guardianship_id = v_guardianship
    WHERE id = v_invitation.id;
  RETURN QUERY SELECT 'accepted'::text, v_guardianship;
END
$$;
REVOKE EXECUTE ON FUNCTION app.accept_guardian_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_guardian_invitation(text, text) TO clubadmin_app;
