ALTER TABLE "guardian_invitations" ADD COLUMN "resent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "adult_decision" text;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "adult_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "granted_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "recorded_by_club_id" uuid;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "consent_note" text;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "guardianships" ADD COLUMN "own_login_age_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_granted_by_person_id_people_id_fk" FOREIGN KEY ("granted_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_merges_merged_by_idx" ON "people_merges" USING btree ("merged_by_person_id");--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_adult_decision" CHECK ("guardianships"."adult_decision" IS NULL OR "guardianships"."adult_decision" IN ('kept', 'ended'));--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_adult_decided" CHECK (("guardianships"."adult_decision" IS NULL) = ("guardianships"."adult_decided_at" IS NULL));--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_consent_note_length" CHECK (char_length("guardianships"."consent_note") <= 500);--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_ended_reason_length" CHECK (char_length("guardianships"."ended_reason") <= 500);--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.3): families, relatives and contact persons, adult
-- decisions.
-------------------------------------------------------------------------------

-- In the hand-written part so the schema modules (people, clubs) do not import
-- each other.
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_recorded_by_club_id_clubs_id_fk"
  FOREIGN KEY ("recorded_by_club_id") REFERENCES "public"."clubs"("id");
--> statement-breakpoint

-- The ward themselves may now write their guardianships too: an adult (or a
-- young person from the consent age) links relatives and contact persons to
-- themselves, changes or ends those links, and records the adult decision.
-- Which of these is allowed is decided by the guardianships service.
DROP POLICY guardianship_access ON public.guardianships;
CREATE POLICY guardianship_access ON public.guardianships
  USING (
    app.is_system() OR guardian_person_id = app.current_person_id() OR ward_person_id = app.current_person_id()
    OR app.is_guardian_of(ward_person_id) OR app.is_current_club_member(ward_person_id)
  )
  WITH CHECK (
    app.is_system() OR guardian_person_id = app.current_person_id() OR ward_person_id = app.current_person_id()
    OR app.is_guardian_of(ward_person_id) OR app.is_current_club_member(ward_person_id)
  );
--> statement-breakpoint

-- Invitations: also readable by the ward (their guardians list shows pending
-- invitations; the API shows the email to full guardians only).
DROP POLICY invitation_access ON public.guardian_invitations;
CREATE POLICY invitation_access ON public.guardian_invitations
  USING (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
  )
  WITH CHECK (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
  );
--> statement-breakpoint

-- Accepting with the caller's verified login email, which must be the
-- address the invitation was sent to. Status 'invalid' covers unknown,
-- expired, revoked and used tokens alike; 'email_mismatch' only a valid one.
-- The rights chosen by the inviter are granted by the inviter. Replaces the
-- one-argument version of 0001 (dropped by a later migration).
CREATE FUNCTION app.accept_guardian_invitation(p_token_hash text, p_email text)
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
    (guardian_person_id, ward_person_id, kind, rights, status, created_by_person_id, granted_by_person_id)
  VALUES (v_me, v_invitation.ward_person_id, v_invitation.kind, v_invitation.rights, 'active',
    v_invitation.invited_by_person_id,
    CASE WHEN v_invitation.kind IN ('relative', 'contact_person') THEN v_invitation.invited_by_person_id END)
  RETURNING id INTO v_guardianship;
  UPDATE public.guardian_invitations
    SET accepted_at = now(), accepted_by_person_id = v_me, guardianship_id = v_guardianship
    WHERE id = v_invitation.id;
  RETURN QUERY SELECT 'accepted'::text, v_guardianship;
END
$$;
REVOKE EXECUTE ON FUNCTION app.accept_guardian_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_guardian_invitation(text, text) TO clubadmin_app;
--> statement-breakpoint

-- Duplicate candidates for a guardian (P1.3, computed, never stored): pairs
-- of one of the acting person's wards (as a full guardian) and another ward
-- of theirs or of one of their full co-guardians with the same birth date
-- and family name (people_duplicate_idx) or the same personal identity
-- number (people_pin_hash_idx). Only IDs and the reason; the API shows the
-- people through the person presenter, which leaves out protected people the
-- guardian may not see.
CREATE FUNCTION app.family_duplicate_candidates()
  RETURNS TABLE (person_id uuid, duplicate_person_id uuid, reason text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH mine AS (
    SELECT g.ward_person_id AS id FROM public.guardianships g
    WHERE g.guardian_person_id = app.current_person_id() AND g.kind IN ('parent', 'legal_guardian')
      AND g.status = 'active' AND g.valid_to IS NULL
  ), co AS (
    SELECT DISTINCT other.guardian_person_id AS id FROM public.guardianships other
    WHERE other.ward_person_id IN (SELECT id FROM mine) AND other.guardian_person_id <> app.current_person_id()
      AND other.kind IN ('parent', 'legal_guardian') AND other.status = 'active' AND other.valid_to IS NULL
  ), reach AS (
    SELECT id FROM mine
    UNION
    SELECT g.ward_person_id FROM public.guardianships g
    WHERE g.guardian_person_id IN (SELECT id FROM co) AND g.kind IN ('parent', 'legal_guardian')
      AND g.status = 'active' AND g.valid_to IS NULL
  )
  SELECT a.id, b.id,
    CASE WHEN a.personal_identity_number_hash IS NOT NULL
      AND a.personal_identity_number_hash = b.personal_identity_number_hash
      THEN 'personal_identity_number' ELSE 'name_and_birth_date' END
  FROM public.people a
  JOIN public.people b ON b.id <> a.id AND b.id IN (SELECT id FROM reach)
    AND ((b.birth_date = a.birth_date AND lower(b.family_name) = lower(a.family_name))
      OR (a.personal_identity_number_hash IS NOT NULL
        AND b.personal_identity_number_hash = a.personal_identity_number_hash))
  WHERE a.id IN (SELECT id FROM mine)
    AND a.merged_into_person_id IS NULL AND b.merged_into_person_id IS NULL
    AND a.anonymized_at IS NULL AND b.anonymized_at IS NULL
    -- Each pair once when both are the guardian's own wards.
    AND (b.id NOT IN (SELECT id FROM mine) OR a.id < b.id)
  ORDER BY a.id, b.id
$$;
REVOKE EXECUTE ON FUNCTION app.family_duplicate_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.family_duplicate_candidates() TO clubadmin_app;
--> statement-breakpoint

-- Age rules per ward (issue #6): the worker reads the countries of the clubs
-- a person belongs to (open memberships), outside any club. Read-only, IDs
-- and club IDs only.
CREATE POLICY system_read ON public.club_memberships FOR SELECT USING (app.is_system());
