-- P2.7 part A (ADR 0051, decisions of 2026-11-18): plugins for grant
-- reporting and background checks. A club enables the installation's plugins
-- and configures them (their secrets encrypted, apart, without history);
-- each plugin has a small key-value state per club. Grant reports keep a
-- period's evaluation (IDs and codes only), lock it and track exports and
-- submissions. Background checks keep only metadata (never a document, a
-- code or a negative outcome) and the club's requests. A group can be marked
-- adapted (parasport, adapted activities): the `disability` data of the
-- plugin contract, with no health data about a person.

ALTER TABLE public.groups ADD COLUMN adapted boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE TABLE public.club_plugins (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  plugin_id text NOT NULL CONSTRAINT club_plugins_plugin_id CHECK (plugin_id ~ '^[a-z]{2,}(\.[a-z0-9-]+)+$'),
  enabled boolean NOT NULL DEFAULT false,
  -- Validated against the plugin's manifest by the API; no secrets.
  config jsonb NOT NULL DEFAULT '{}' CONSTRAINT club_plugins_config CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT club_plugins_unique UNIQUE (club_id, plugin_id)
);

-- A plugin's secrets per club (envelope-encrypted with the club's key); no
-- history (HISTORY_EXCLUSIONS): only that one was set matters, audited.
CREATE TABLE public.club_plugin_secrets (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  plugin_id text NOT NULL,
  name text NOT NULL CONSTRAINT club_plugin_secrets_name CHECK (name ~ '^[a-z][a-zA-Z0-9]{0,39}$'),
  value text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT club_plugin_secrets_plugin_fk FOREIGN KEY (club_id, plugin_id)
    REFERENCES public.club_plugins (club_id, plugin_id) ON DELETE CASCADE,
  CONSTRAINT club_plugin_secrets_unique UNIQUE (club_id, plugin_id, name)
);

CREATE TABLE public.plugin_state (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  plugin_id text NOT NULL,
  key text NOT NULL CONSTRAINT plugin_state_key CHECK (char_length(key) BETWEEN 1 AND 200),
  value jsonb NOT NULL CONSTRAINT plugin_state_size CHECK (pg_column_size(value) <= 65536),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT plugin_state_plugin_fk FOREIGN KEY (club_id, plugin_id)
    REFERENCES public.club_plugins (club_id, plugin_id) ON DELETE CASCADE,
  CONSTRAINT plugin_state_unique UNIQUE (club_id, plugin_id, key)
);

-- A period's grant report: the evaluation as the plugin returned it (IDs and
-- codes only), locked by a person, exported or submitted. Attendance changed
-- in a locked period sets attendance_changed_at.
CREATE TABLE public.grant_reports (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  plugin_id text NOT NULL,
  scheme_key text NOT NULL,
  period_key text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CONSTRAINT grant_reports_status
    CHECK (status IN ('draft', 'locked', 'exported', 'submitted', 'accepted', 'rejected')),
  evaluation jsonb,
  totals jsonb NOT NULL DEFAULT '[]' CONSTRAINT grant_reports_totals CHECK (jsonb_typeof(totals) = 'array'),
  evaluated_at timestamptz,
  locked_by_person_id uuid REFERENCES public.people(id),
  locked_at timestamptz,
  attendance_changed_at timestamptz,
  submission_receipt text,
  submission_reason text,
  submitted_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT grant_reports_period CHECK (period_to >= period_from),
  CONSTRAINT grant_reports_locked CHECK (status = 'draft' OR locked_at IS NOT NULL),
  CONSTRAINT grant_reports_plugin_fk FOREIGN KEY (club_id, plugin_id)
    REFERENCES public.club_plugins (club_id, plugin_id),
  CONSTRAINT grant_reports_unique UNIQUE (club_id, plugin_id, scheme_key, period_key)
);
-- Locked periods a changed attendance falls in (club and dates).
CREATE INDEX grant_reports_period_idx ON public.grant_reports (club_id, period_from, period_to)
  WHERE status <> 'draft';

-- Background checks: metadata only (ADR 0051): never a document, a picture,
-- a reference code or a negative outcome. Kept until deleted (P2.8).
CREATE TABLE public.background_checks (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  person_id uuid NOT NULL REFERENCES public.people(id),
  plugin_id text NOT NULL,
  check_type text NOT NULL CONSTRAINT background_checks_type CHECK (check_type ~ '^[a-z][a-z0-9_-]{0,39}$'),
  issuing_country text NOT NULL CONSTRAINT background_checks_country CHECK (issuing_country ~ '^[A-Z]{2}$'),
  issued_on date NOT NULL,
  verified_on date NOT NULL,
  verified_by_person_id uuid REFERENCES public.people(id),
  method text NOT NULL CONSTRAINT background_checks_method
    CHECK (method IN ('viewed', 'code_lookup', 'digital_mailbox', 'received_by_club', 'federation_feed')),
  valid_until date,
  superseded_by_id uuid REFERENCES public.background_checks(id),
  -- Why a record stopped counting, never why a check failed.
  closed_reason_code text CONSTRAINT background_checks_closed CHECK (closed_reason_code IN ('expired', 'superseded', 'closed')),
  closed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT background_checks_dates CHECK (verified_on >= issued_on)
);
CREATE INDEX background_checks_person_idx ON public.background_checks (club_id, person_id);
CREATE INDEX background_checks_valid_idx ON public.background_checks (club_id, valid_until)
  WHERE closed_at IS NULL;
CREATE INDEX background_checks_verified_by_idx ON public.background_checks (verified_by_person_id)
  WHERE verified_by_person_id IS NOT NULL;

-- Checks the club requests (with the person's consent, e.g. Norway).
CREATE TABLE public.background_check_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  person_id uuid NOT NULL REFERENCES public.people(id),
  plugin_id text NOT NULL,
  check_type text NOT NULL,
  status text NOT NULL CONSTRAINT background_check_requests_status
    CHECK (status IN ('requested', 'consent_pending', 'submitted', 'result_available', 'verified', 'closed')),
  -- The plugin's reference to ask again; not a certificate's code.
  plugin_reference text NOT NULL CONSTRAINT background_check_requests_reference CHECK (char_length(plugin_reference) <= 200),
  requested_by_person_id uuid REFERENCES public.people(id),
  check_id uuid REFERENCES public.background_checks(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX background_check_requests_person_idx ON public.background_check_requests (club_id, person_id);
CREATE INDEX background_check_requests_open_idx ON public.background_check_requests (club_id, status)
  WHERE status NOT IN ('verified', 'closed');
CREATE INDEX background_check_requests_by_idx ON public.background_check_requests (requested_by_person_id)
  WHERE requested_by_person_id IS NOT NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.club_plugins'), app.enable_updated_at('public.club_plugins'),
  history.enable_history('public.club_plugins');
SELECT app.enable_tenant_rls('public.club_plugin_secrets'), app.enable_updated_at('public.club_plugin_secrets');
SELECT app.enable_tenant_rls('public.plugin_state'), app.enable_updated_at('public.plugin_state'),
  history.enable_history('public.plugin_state');
SELECT app.enable_tenant_rls('public.grant_reports'), app.enable_updated_at('public.grant_reports'),
  history.enable_history('public.grant_reports');
SELECT app.enable_tenant_rls('public.background_checks'), app.enable_updated_at('public.background_checks'),
  history.enable_history('public.background_checks');
SELECT app.enable_tenant_rls('public.background_check_requests'),
  app.enable_updated_at('public.background_check_requests'),
  history.enable_history('public.background_check_requests');
--> statement-breakpoint

-- Plugins, grants and background checks in the template roles (the
-- template of 0051 with these rows): club managers enable plugins; club
-- managers, registrars and treasurers read grant reports; registrars and
-- treasurers lock, export and submit them; club managers and registrars
-- follow up background checks.
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
    ('club_manager', 'club', 'club.plugins.manage'),
    ('club_manager', 'club', 'club.grants.read'),
    ('club_manager', 'club', 'club.background_checks.manage'),
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
    ('registrar', 'club', 'club.grants.read'),
    ('registrar', 'club', 'club.grants.report'),
    ('registrar', 'club', 'club.background_checks.manage'),
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
    ('treasurer', 'club', 'club.grants.read'),
    ('treasurer', 'club', 'club.grants.report'),
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
WHERE t.permission IN ('club.plugins.manage', 'club.grants.read', 'club.grants.report', 'club.background_checks.manage')
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
      WHERE t.permission IN ('club.plugins.manage', 'club.grants.read', 'club.grants.report', 'club.background_checks.manage')
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Erasure (P1.8b): the function of 0051 with the background-check steps.
GRANT SELECT, DELETE ON public.background_checks, public.background_check_requests TO clubadmin_retention;
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

  -- Background checks (P2.7, ADR 0051): the records and requests about the
  -- person go; grant reports keep their IDs (the person above is anonymised).
  DELETE FROM public.background_check_requests WHERE person_id = p_person_id;
  v_changed := v_changed OR FOUND;
  DELETE FROM public.background_checks WHERE person_id = p_person_id;
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
