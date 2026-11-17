-- P2.5 part B (ADR 0048 decisions 9–10): mileage reimbursement and the
-- attestation of expense claims. The mileage rate is a board setting
-- (minor units of the club's currency per km; none: reimbursement off),
-- applied from a recorded decision like the privacy settings; a decision of
-- the rate alone publishes no new privacy policy version.
-- A driver turns drives into a claim (kind `mileage`, lines per drive) for
-- one group; it is routed to the activity's creator if they may attest,
-- otherwise to the group's attesters, then the club's; approved claims are
-- exported. Claims are kept for the accounting; erasure anonymises.

ALTER TABLE public.clubs ADD COLUMN mileage_rate integer
  CONSTRAINT clubs_mileage_rate CHECK (mileage_rate BETWEEN 0 AND 100000);
--> statement-breakpoint

-- Applies a recorded board decision (0020's function with the mileage rate):
-- whether it was applied now, and the privacy policy version it published
-- (none when the decision holds no setting the policy shows, or not applied).
CREATE FUNCTION app.apply_board_decision(p_decision_id uuid, p_template_version integer)
  RETURNS TABLE (applied boolean, policy_id uuid)
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_decision public.club_setting_decisions;
  v_club public.clubs;
  v_settings jsonb;
  v_before jsonb;
  v_policy uuid;
BEGIN
  SELECT * INTO v_decision FROM public.club_setting_decisions WHERE id = p_decision_id FOR UPDATE;
  IF NOT FOUND OR v_decision.applied_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO v_club FROM public.clubs WHERE id = v_decision.club_id FOR UPDATE;
  v_before := app.policy_settings(v_club);
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
      (v_settings ->> 'consent_reconfirm_on_new_version')::boolean, consent_reconfirm_on_new_version),
    -- A rate of none (JSON null) turns reimbursement off.
    mileage_rate = CASE WHEN v_settings ? 'mileage_rate'
      THEN (v_settings ->> 'mileage_rate')::integer ELSE mileage_rate END
  WHERE id = v_club.id
  RETURNING * INTO v_club;
  UPDATE public.club_setting_decisions SET applied_at = now() WHERE id = p_decision_id;
  -- A decision of privacy settings publishes the policy's next version (as
  -- before); one of the mileage rate alone does not (the policy omits it).
  IF (v_settings - 'mileage_rate') <> '{}'::jsonb THEN
    IF NOT EXISTS (SELECT 1 FROM public.club_privacy_policies WHERE club_id = v_club.id) THEN
      INSERT INTO public.club_privacy_policies (club_id, version, template_version, settings, effective_from)
      VALUES (v_club.id, 1, p_template_version, v_before, v_club.created_at::date);
    END IF;
    INSERT INTO public.club_privacy_policies
      (club_id, version, template_version, settings, decision_id, effective_from)
    SELECT v_club.id, coalesce(max(version), 0) + 1, p_template_version, app.policy_settings(v_club),
      p_decision_id, v_decision.effective_from
    FROM public.club_privacy_policies WHERE club_id = v_club.id
    RETURNING id INTO v_policy;
  END IF;
  RETURN QUERY SELECT true, v_policy;
END
$$;
REVOKE ALL ON FUNCTION app.apply_board_decision(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_board_decision(uuid, integer) TO clubadmin_app;

-- The old entry point (an API or worker of the previous release during a
-- rolling deploy): the policy it published, as before.
CREATE OR REPLACE FUNCTION app.apply_setting_decision(p_decision_id uuid, p_template_version integer)
  RETURNS uuid
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.policy_id FROM app.apply_board_decision(p_decision_id, p_template_version) d
$$;
--> statement-breakpoint

CREATE TABLE public.expense_claims (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  kind text NOT NULL CONSTRAINT expense_claims_kind CHECK (kind IN ('mileage')),
  claimant_person_id uuid NOT NULL REFERENCES public.people(id),
  group_id uuid NOT NULL,
  -- The one activity all its lines are for, if so.
  activity_id uuid,
  -- Whom it was routed to: the activity's creator when they may attest.
  routed_to_person_id uuid REFERENCES public.people(id),
  amount_minor bigint NOT NULL CONSTRAINT expense_claims_amount CHECK (amount_minor >= 0),
  currency text NOT NULL CONSTRAINT expense_claims_currency CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'submitted' CONSTRAINT expense_claims_status
    CHECK (status IN ('submitted', 'approved', 'rejected', 'exported', 'paid')),
  decided_by_person_id uuid REFERENCES public.people(id),
  decided_at timestamptz,
  -- The attester's reason (a rejection always has one when decided; erasure clears it).
  reason text CONSTRAINT expense_claims_reason CHECK (char_length(reason) <= 500),
  exported_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT expense_claims_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT expense_claims_group_fk FOREIGN KEY (club_id, group_id)
    REFERENCES public.groups (club_id, id),
  CONSTRAINT expense_claims_activity_fk FOREIGN KEY (club_id, activity_id)
    REFERENCES public.activities (club_id, id) ON DELETE SET NULL (activity_id),
  CONSTRAINT expense_claims_decided CHECK ((decided_by_person_id IS NULL) = (decided_at IS NULL)),
  CONSTRAINT expense_claims_decided_status CHECK ((status = 'submitted') = (decided_at IS NULL)),
  CONSTRAINT expense_claims_not_own CHECK (decided_by_person_id IS DISTINCT FROM claimant_person_id)
);
-- The queue of a club (by status, oldest first), a group's, a claimant's.
CREATE INDEX expense_claims_club_idx ON public.expense_claims (club_id, status, id);
CREATE INDEX expense_claims_group_idx ON public.expense_claims (group_id, status, id);
CREATE INDEX expense_claims_claimant_idx ON public.expense_claims (claimant_person_id, id);
CREATE INDEX expense_claims_routed_idx ON public.expense_claims (routed_to_person_id)
  WHERE routed_to_person_id IS NOT NULL;
CREATE INDEX expense_claims_decided_by_idx ON public.expense_claims (decided_by_person_id)
  WHERE decided_by_person_id IS NOT NULL;
CREATE INDEX expense_claims_activity_idx ON public.expense_claims (activity_id)
  WHERE activity_id IS NOT NULL;
-- The export: decided claims by the day they were decided.
CREATE INDEX expense_claims_decided_idx ON public.expense_claims (club_id, decided_at)
  WHERE decided_at IS NOT NULL;

CREATE TABLE public.expense_claim_lines (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  claim_id uuid NOT NULL,
  -- The drive (a mileage line); none once the car pool is deleted.
  offer_id uuid,
  description text NOT NULL CONSTRAINT expense_claim_lines_description
    CHECK (char_length(description) BETWEEN 1 AND 200),
  quantity numeric(8, 1) NOT NULL CONSTRAINT expense_claim_lines_quantity CHECK (quantity >= 0),
  unit_amount_minor integer NOT NULL CONSTRAINT expense_claim_lines_unit CHECK (unit_amount_minor >= 0),
  amount_minor bigint NOT NULL CONSTRAINT expense_claim_lines_amount CHECK (amount_minor >= 0),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT expense_claim_lines_claim_fk FOREIGN KEY (club_id, claim_id)
    REFERENCES public.expense_claims (club_id, id) ON DELETE CASCADE,
  CONSTRAINT expense_claim_lines_offer_fk FOREIGN KEY (club_id, offer_id)
    REFERENCES public.carpool_offers (club_id, id) ON DELETE SET NULL (offer_id)
);
CREATE INDEX expense_claim_lines_claim_idx ON public.expense_claim_lines (claim_id);
-- A drive is claimed once (unless that claim was rejected; the service checks).
CREATE INDEX expense_claim_lines_offer_idx ON public.expense_claim_lines (offer_id)
  WHERE offer_id IS NOT NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.expense_claims'), app.enable_updated_at('public.expense_claims'),
  history.enable_history('public.expense_claims');
SELECT app.enable_tenant_rls('public.expense_claim_lines'),
  app.enable_updated_at('public.expense_claim_lines'), history.enable_history('public.expense_claim_lines');
--> statement-breakpoint

-- "Mina utlägg": the caller's claims across their clubs (each read in turn,
-- tenant RLS, as app.my_carpools), newest first, after the cursor; with the
-- group's name and the lines. By the claimant index; the caller merges.
CREATE FUNCTION app.my_expense_claims(p_cursor uuid, p_limit integer)
  RETURNS TABLE (club_id uuid, club_name text, claim_id uuid, kind text, group_id uuid,
    group_name text, activity_id uuid, amount_minor bigint, currency text, status text,
    routed_to_person_id uuid, decided_by_person_id uuid, decided_at timestamptz, reason text,
    created_at timestamptz, lines jsonb)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := app.current_person_id();
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_club uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN;
  END IF;
  -- A guardian who is no member drives for their child's club: the wards' clubs too.
  FOREACH v_club IN ARRAY app.my_clubs_for(app.self_and_wards()) LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    RETURN QUERY
    SELECT c.club_id, (SELECT cl.name FROM public.clubs cl WHERE cl.id = c.club_id), c.id, c.kind,
      c.group_id, (SELECT g.name FROM public.groups g WHERE g.id = c.group_id), c.activity_id,
      c.amount_minor, c.currency, c.status, c.routed_to_person_id, c.decided_by_person_id,
      c.decided_at, c.reason, c.created_at,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'offer_id', l.offer_id,
          'description', l.description, 'quantity', l.quantity,
          'unit_amount_minor', l.unit_amount_minor, 'amount_minor', l.amount_minor) ORDER BY l.id)
        FROM public.expense_claim_lines l WHERE l.claim_id = c.id), '[]')
    FROM public.expense_claims c
    WHERE c.claimant_person_id = v_me AND c.club_id = v_club
      AND (p_cursor IS NULL OR c.id < p_cursor)
    ORDER BY c.id DESC
    LIMIT p_limit;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_expense_claims(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_expense_claims(uuid, integer) TO clubadmin_app;
--> statement-breakpoint

-- Attesting claims (the template of 0048 with these rows): head coaches and
-- team managers in their groups, treasurers in the club.
CREATE OR REPLACE FUNCTION app.builtin_role_template()
  RETURNS TABLE (template_key text, scope text, permission text)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM (VALUES
    ('club_manager', 'club', 'club.settings.update'),
    ('club_manager', 'club', 'club.roles.manage'),
    ('club_manager', 'club', 'club.roles.read'),
    ('club_manager', 'club', 'club.people.protected'),
    ('club_manager', 'club', 'club.members.read'),
    ('club_manager', 'club', 'club.join_requests.manage'),
    ('club_manager', 'club', 'club.invitations.manage'),
    ('club_manager', 'club', 'club.waitlists.read'),
    ('club_manager', 'club', 'club.groups.archived.read'),
    ('club_manager', 'club', 'club.groups.create'),
    ('club_manager', 'club', 'group.update'),
    ('club_manager', 'club', 'group.owners.manage'),
    ('club_manager', 'club', 'group.members.read'),
    ('club_manager', 'club', 'group.members.manage'),
    ('club_manager', 'club', 'group.waitlist.manage'),
    ('club_manager', 'club', 'group.activities.read'),
    ('club_manager', 'club', 'group.activities.manage'),
    ('club_manager', 'club', 'club.activities.read'),
    ('club_manager', 'club', 'club.locations.manage'),
    ('club_manager', 'club', 'club.locations.create'),
    ('club_manager', 'club', 'club.events.create'),
    ('club_manager', 'club', 'event.read'),
    ('club_manager', 'club', 'event.manage'),
    ('club_manager', 'club', 'person.protection.set'),
    ('club_manager', 'club', 'person.merge'),
    ('club_manager', 'club', 'club.guardianships.end'),
    ('club_manager', 'club', 'club.history.read'),
    ('club_manager', 'club', 'club.audit.read'),
    ('club_manager', 'club', 'group.history.read'),
    ('club_manager', 'club', 'activity.history.read'),
    ('club_manager', 'club', 'event.history.read'),
    ('club_manager', 'club', 'club.profile_views.read'),
    ('club_manager', 'club', 'club.profile_views.configure'),
    ('club_manager', 'club', 'billing.subscription.read'),
    ('club_manager', 'club', 'billing.subscription.change'),
    ('club_manager', 'club', 'billing.account.manage'),
    ('club_manager', 'club', 'billing.invoices.read'),
    ('club_manager', 'club', 'club.channels.create'),
    ('club_manager', 'club', 'club.documents.manage'),
    ('club_manager', 'club', 'club.announcements.send'),
    ('club_manager', 'club', 'club.carpools.manage'),
    ('registrar', 'club', 'club.people.details'),
    ('registrar', 'club', 'club.people.protected'),
    ('registrar', 'club', 'club.members.read'),
    ('registrar', 'club', 'club.members.manage'),
    ('registrar', 'club', 'club.members.export'),
    ('registrar', 'club', 'club.members.add'),
    ('registrar', 'club', 'club.members.import'),
    ('registrar', 'club', 'club.join_requests.manage'),
    ('registrar', 'club', 'club.invitations.manage'),
    ('registrar', 'club', 'club.guardians.manage'),
    ('registrar', 'club', 'club.waitlists.read'),
    ('registrar', 'club', 'club.groups.archived.read'),
    ('registrar', 'club', 'club.activities.read'),
    ('registrar', 'club', 'group.members.read'),
    ('registrar', 'club', 'group.activities.read'),
    ('registrar', 'club', 'group.attendance.read'),
    ('registrar', 'club', 'activity.attendance.manage'),
    ('registrar', 'club', 'event.read'),
    ('registrar', 'club', 'event.registrations.read'),
    ('registrar', 'club', 'person.own_login.invite'),
    ('registrar', 'club', 'person.consents.read'),
    ('registrar', 'club', 'person.consents.manage'),
    ('registrar', 'club', 'group.consents.read'),
    ('registrar', 'club', 'person.history.read'),
    ('registrar', 'club', 'group.history.read'),
    ('registrar', 'club', 'activity.history.read'),
    ('registrar', 'club', 'event.history.read'),
    ('registrar', 'club', 'club.members.routine'),
    ('registrar', 'club', 'club.roles.read'),
    ('chair', 'club', 'club.members.read'),
    ('chair', 'club', 'club.activities.read'),
    ('chair', 'club', 'club.events.create'),
    ('chair', 'club', 'club.managers.claim'),
    ('chair', 'club', 'club.roles.read'),
    ('chair', 'club', 'club.channels.create'),
    ('chair', 'club', 'club.announcements.send'),
    ('chair', 'club', 'club.governing_documents.manage'),
    ('chair', 'club', 'club.governing_documents.adopt'),
    ('vice_chair', 'club', 'club.members.read'),
    ('vice_chair', 'club', 'club.activities.read'),
    ('vice_chair', 'club', 'club.events.create'),
    ('treasurer', 'club', 'club.members.read'),
    ('treasurer', 'club', 'club.activities.read'),
    ('treasurer', 'club', 'club.events.create'),
    ('treasurer', 'club', 'billing.subscription.read'),
    ('treasurer', 'club', 'billing.account.manage'),
    ('treasurer', 'club', 'billing.invoices.read'),
    ('treasurer', 'club', 'club.carpools.manage'),
    ('treasurer', 'club', 'club.expenses.attest'),
    ('secretary', 'club', 'club.members.read'),
    ('secretary', 'club', 'club.activities.read'),
    ('secretary', 'club', 'club.events.create'),
    ('secretary', 'club', 'club.documents.manage'),
    ('secretary', 'club', 'club.announcements.send'),
    ('secretary', 'club', 'club.governing_documents.manage'),
    ('secretary', 'club', 'club.governing_documents.adopt'),
    ('board_member', 'club', 'club.members.read'),
    ('board_member', 'club', 'club.activities.read'),
    ('board_member', 'club', 'club.events.create'),
    ('deputy_board_member', 'club', 'club.members.read'),
    ('deputy_board_member', 'club', 'club.activities.read'),
    ('deputy_board_member', 'club', 'club.events.create'),
    ('auditor', 'club', NULL),
    ('nomination_committee', 'club', NULL),
    ('safeguarding_officer', 'club', 'club.safeguarding.handle'),
    ('communications', 'club', 'club.announcements.send'),
    ('staff', 'club', NULL),
    ('member', 'group', 'group.participate'),
    ('member', 'group', 'group.channels.create'),
    ('head_coach', 'group', 'group.lead'),
    ('head_coach', 'group', 'group.people.details'),
    ('head_coach', 'group', 'person.consents.read'),
    ('head_coach', 'group', 'group.consents.read'),
    ('head_coach', 'group', 'group.activities.manage'),
    ('head_coach', 'group', 'activity.responses.read'),
    ('head_coach', 'group', 'group.channels.create'),
    ('head_coach', 'group', 'group.channels.manage'),
    ('head_coach', 'group', 'group.documents.manage'),
    ('head_coach', 'group', 'group.announcements.send'),
    ('head_coach', 'group', 'group.expenses.attest'),
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.channels.create'),
    ('assistant_coach', 'group', 'group.documents.manage'),
    ('assistant_coach', 'group', 'group.announcements.send'),
    ('team_manager', 'group', 'group.lead'),
    ('team_manager', 'group', 'group.people.details'),
    ('team_manager', 'group', 'person.consents.read'),
    ('team_manager', 'group', 'group.consents.read'),
    ('team_manager', 'group', 'group.activities.manage'),
    ('team_manager', 'group', 'activity.responses.read'),
    ('team_manager', 'group', 'group.channels.create'),
    ('team_manager', 'group', 'group.documents.manage'),
    ('team_manager', 'group', 'group.announcements.send'),
    ('team_manager', 'group', 'group.expenses.attest'),
    ('physio', 'group', 'group.lead'),
    ('physio', 'group', 'group.people.details'),
    ('physio', 'group', 'person.consents.read'),
    ('physio', 'group', 'group.consents.read'),
    ('other_leader', 'group', 'group.lead'),
    ('other_leader', 'group', 'group.people.details'),
    ('other_leader', 'group', 'person.consents.read'),
    ('other_leader', 'group', 'group.consents.read'),
    ('other_leader', 'group', 'activity.responses.read')
  ) AS t (template_key, scope, permission)
$$;
--> statement-breakpoint

INSERT INTO public.club_type_role_permissions (club_type_role_id, permission)
SELECT r.id, t.permission
FROM app.builtin_role_template() t
JOIN public.club_type_roles r ON r.scope = t.scope AND r.key = t.template_key
WHERE t.permission IN ('club.expenses.attest', 'group.expenses.attest')
ON CONFLICT (club_type_role_id, permission) DO NOTHING;

DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs ORDER BY id LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    WITH added AS (
      INSERT INTO public.role_permissions (club_id, role_id, permission)
      SELECT v_club, r.id, t.permission
      FROM app.builtin_role_template() t
      JOIN public.roles r ON r.club_id = v_club AND r.scope = t.scope AND r.template_key = t.template_key
      WHERE t.permission IN ('club.expenses.attest', 'group.expenses.attest')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Erasure (P1.8b): the attester's reason on the person's claims goes (the
-- function of 0049 with that step); the claims stay for the accounting.
GRANT SELECT, UPDATE ON public.expense_claims TO clubadmin_retention;
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
