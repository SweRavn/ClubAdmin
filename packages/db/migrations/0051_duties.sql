-- P2.6 part A (ADR 0050 and its amendment of 2026-11-18): volunteer duties.
-- The club's catalogue of duty types (with the contact with children each
-- means; an adult alone with children only where the country pack and the
-- club allow it, checked by the service), shifts as tasks of kind
-- `duty_shift` (ADR 0052) with their type, place and the number needed,
-- quotas per group and season, the club's duty settings and a group's
-- visibility, swaps of shifts (offered or asked for, P2.6 part B), and,
-- prepared, people's unavailability (Phase 4) and buying out (Phase 3).

CREATE TABLE public.duty_types (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  name text NOT NULL CONSTRAINT duty_types_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  instruction text CONSTRAINT duty_types_instruction CHECK (char_length(instruction) <= 2000),
  -- The club's documents with the instruction (ADR 0049); read by the shifts' readers.
  instruction_document_ids uuid[] NOT NULL DEFAULT '{}',
  min_age integer CONSTRAINT duty_types_min_age CHECK (min_age BETWEEN 0 AND 99),
  -- The contact with children the duty means (the background-check
  -- categories of P2.8 map to it; alone_with_children only where allowed).
  child_contact text NOT NULL DEFAULT 'none' CONSTRAINT duty_types_child_contact
    CHECK (child_contact IN ('none', 'with_children', 'alone_with_children')),
  -- Prepared for the qualifications register (Phase 4): keys, not checked.
  required_qualifications jsonb NOT NULL DEFAULT '[]'
    CONSTRAINT duty_types_qualifications CHECK (jsonb_typeof(required_qualifications) = 'array'),
  archived_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT duty_types_club_id_unique UNIQUE (club_id, id)
);
CREATE UNIQUE INDEX duty_types_name_unique ON public.duty_types (club_id, lower(name))
  WHERE archived_at IS NULL;
--> statement-breakpoint

-- Shifts are tasks (ADR 0052): the kind, their type and place.
ALTER TABLE public.tasks DROP CONSTRAINT tasks_kind;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_kind CHECK (kind IN ('action_item', 'duty_shift'));
ALTER TABLE public.tasks ADD COLUMN duty_type_id uuid;
ALTER TABLE public.tasks ADD COLUMN location_id uuid;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_duty_type_fk FOREIGN KEY (club_id, duty_type_id)
  REFERENCES public.duty_types (club_id, id);
ALTER TABLE public.tasks ADD CONSTRAINT tasks_location_fk FOREIGN KEY (club_id, location_id)
  REFERENCES public.locations (club_id, id) ON DELETE SET NULL (location_id);
ALTER TABLE public.tasks ADD CONSTRAINT tasks_duty_shift CHECK (kind <> 'duty_shift'
  OR (duty_type_id IS NOT NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL));
CREATE INDEX tasks_duty_type_idx ON public.tasks (duty_type_id) WHERE duty_type_id IS NOT NULL;
CREATE INDEX tasks_location_idx ON public.tasks (location_id) WHERE location_id IS NOT NULL;
-- A group's shifts and the club's own by time (the leaders' lists, the quotas).
CREATE INDEX tasks_group_shifts_idx ON public.tasks (group_id, starts_at) WHERE kind = 'duty_shift';
CREATE INDEX tasks_club_shifts_idx ON public.tasks (club_id, starts_at)
  WHERE kind = 'duty_shift' AND group_id IS NULL;
-- Bought out instead of done (prepared for Phase 3).
ALTER TABLE public.task_assignments ADD COLUMN bought_out boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Shifts per player and season in a group (none: no quota).
CREATE TABLE public.duty_quotas (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  group_id uuid NOT NULL,
  season_id uuid NOT NULL,
  shifts_per_player integer NOT NULL CONSTRAINT duty_quotas_shifts CHECK (shifts_per_player BETWEEN 0 AND 100),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT duty_quotas_group_fk FOREIGN KEY (club_id, group_id) REFERENCES public.groups (club_id, id),
  CONSTRAINT duty_quotas_season_fk FOREIGN KEY (club_id, season_id)
    REFERENCES public.seasons (club_id, id) ON DELETE CASCADE,
  CONSTRAINT duty_quotas_unique UNIQUE (group_id, season_id)
);
CREATE INDEX duty_quotas_season_idx ON public.duty_quotas (season_id);

-- Swaps (P2.6 part B): an assignee offers their shift (whoever takes it
-- confirms), or someone asks to take it over (the assignee accepts).
CREATE TABLE public.task_swaps (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  assignment_id uuid NOT NULL,
  kind text NOT NULL CONSTRAINT task_swaps_kind CHECK (kind IN ('offer', 'request')),
  created_by_person_id uuid NOT NULL REFERENCES public.people(id),
  -- Who takes it over (asked for, or who took an offer) and whose quota it then counts for.
  taker_person_id uuid REFERENCES public.people(id),
  taker_counts_for_person_id uuid REFERENCES public.people(id),
  status text NOT NULL DEFAULT 'open' CONSTRAINT task_swaps_status
    CHECK (status IN ('open', 'done', 'declined', 'withdrawn')),
  decided_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT task_swaps_assignment_fk FOREIGN KEY (club_id, assignment_id)
    REFERENCES public.task_assignments (club_id, id) ON DELETE CASCADE,
  CONSTRAINT task_swaps_request_taker CHECK (kind <> 'request' OR taker_person_id IS NOT NULL),
  CONSTRAINT task_swaps_decided CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX task_swaps_open_offer ON public.task_swaps (assignment_id)
  WHERE status = 'open' AND kind = 'offer';
CREATE INDEX task_swaps_assignment_idx ON public.task_swaps (assignment_id);
CREATE INDEX task_swaps_created_by_idx ON public.task_swaps (created_by_person_id);
CREATE INDEX task_swaps_taker_idx ON public.task_swaps (taker_person_id) WHERE taker_person_id IS NOT NULL;
CREATE INDEX task_swaps_taker_counts_for_idx ON public.task_swaps (taker_counts_for_person_id)
  WHERE taker_counts_for_person_id IS NOT NULL;

-- Unavailability for the automatic distribution (prepared for Phase 4).
CREATE TABLE public.duty_unavailability (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  person_id uuid NOT NULL REFERENCES public.people(id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT duty_unavailability_period CHECK (to_date >= from_date)
);
CREATE INDEX duty_unavailability_person_idx ON public.duty_unavailability (person_id, from_date);

-- The club's duty settings: the default visibility, whether groups may
-- change it, and the club's own ban on an adult alone with children (where
-- the country pack allows it).
CREATE TABLE public.duty_settings (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  visibility text NOT NULL DEFAULT 'names' CONSTRAINT duty_settings_visibility
    CHECK (visibility IN ('open', 'names', 'leaders')),
  groups_may_change_visibility boolean NOT NULL DEFAULT false,
  alone_with_children_forbidden boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT duty_settings_club_unique UNIQUE (club_id)
);
-- A group's own visibility (when the club lets groups change it).
CREATE TABLE public.group_duty_settings (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  group_id uuid NOT NULL,
  visibility text NOT NULL CONSTRAINT group_duty_settings_visibility
    CHECK (visibility IN ('open', 'names', 'leaders')),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT group_duty_settings_group_fk FOREIGN KEY (club_id, group_id)
    REFERENCES public.groups (club_id, id),
  CONSTRAINT group_duty_settings_group_unique UNIQUE (group_id)
);
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.duty_types'), app.enable_updated_at('public.duty_types'),
  history.enable_history('public.duty_types');
SELECT app.enable_tenant_rls('public.duty_quotas'), app.enable_updated_at('public.duty_quotas'),
  history.enable_history('public.duty_quotas');
SELECT app.enable_tenant_rls('public.task_swaps'), app.enable_updated_at('public.task_swaps'),
  history.enable_history('public.task_swaps');
SELECT app.enable_tenant_rls('public.duty_unavailability'),
  app.enable_updated_at('public.duty_unavailability'), history.enable_history('public.duty_unavailability');
SELECT app.enable_tenant_rls('public.duty_settings'), app.enable_updated_at('public.duty_settings'),
  history.enable_history('public.duty_settings');
SELECT app.enable_tenant_rls('public.group_duty_settings'),
  app.enable_updated_at('public.group_duty_settings'), history.enable_history('public.group_duty_settings');
--> statement-breakpoint

-- Marking one's own task from "Mina uppgifter" stays for action items: the
-- leaders mark shifts (the API checks the kind; nothing changes here).

-- Duties in the template roles (the template of 0050 with these rows):
-- club managers keep the catalogue and every group's shifts, coaches and
-- team managers their groups' (owners by owning, the policies).
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
    ('club_manager', 'club', 'club.duties.manage'),
    ('club_manager', 'club', 'club.duty_types.manage'),
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
    ('head_coach', 'group', 'group.duties.manage'),
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.channels.create'),
    ('assistant_coach', 'group', 'group.documents.manage'),
    ('assistant_coach', 'group', 'group.announcements.send'),
    ('assistant_coach', 'group', 'group.duties.manage'),
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
    ('team_manager', 'group', 'group.duties.manage'),
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
WHERE t.permission IN ('club.duties.manage', 'club.duty_types.manage', 'group.duties.manage')
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
      WHERE t.permission IN ('club.duties.manage', 'club.duty_types.manage', 'group.duties.manage')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Erasure (P1.8b): the function of 0050 with the unavailability step.
GRANT SELECT, DELETE ON public.duty_unavailability TO clubadmin_retention;
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

  -- Volunteer duties (P2.6, ADR 0050): the person's stated unavailability
  -- goes; their shifts stay (as the anonymised person above) for the
  -- quotas and the statistics.
  DELETE FROM public.duty_unavailability WHERE person_id = p_person_id;
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
