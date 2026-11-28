-- P2.8 (ADR 0051 decision 6, ADR 0047 rule 6 amended): background checks
-- in Sweden and Norway.
-- - Who needs a check is set on roles: `background_check_category` on the
--   club's roles and the club types' template roles (a requirement, never a
--   permission); the templates head_coach, assistant_coach and team_manager
--   need one for regular contact with children.
-- - Duty types map to a category through their contact with children
--   (P2.6); a club may map a type to a stricter category.
-- - The club's stricter requirements (more categories, shorter re-check
--   intervals) in background_check_club_requirements; the plugin of the
--   club's country is the source of the requirements themselves.
-- - club.background_checks.verify: ticking off a shown certificate
--   (registrar, safeguarding officer); the template of 0055 with these rows.
-- - Records are kept until deleted (P2.8): no automatic deletion.

ALTER TABLE public.roles ADD COLUMN background_check_category text
  CONSTRAINT roles_background_check_category CHECK (background_check_category IN
    ('regular_contact_with_children', 'alone_with_children', 'overnight', 'board'));
ALTER TABLE public.club_type_roles ADD COLUMN background_check_category text
  CONSTRAINT club_type_roles_background_check_category CHECK (background_check_category IN
    ('regular_contact_with_children', 'alone_with_children', 'overnight', 'board'));
ALTER TABLE public.duty_types ADD COLUMN background_check_category text
  CONSTRAINT duty_types_background_check_category CHECK (background_check_category IN
    ('regular_contact_with_children', 'alone_with_children', 'overnight', 'board'));

CREATE TABLE public.background_check_club_requirements (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  plugin_id text NOT NULL CONSTRAINT background_check_club_requirements_plugin
    CHECK (plugin_id ~ '^[a-z][a-z0-9._-]{2,63}$'),
  category text NOT NULL CONSTRAINT background_check_club_requirements_category CHECK (category IN
    ('regular_contact_with_children', 'alone_with_children', 'overnight', 'board')),
  check_type text NOT NULL CONSTRAINT background_check_club_requirements_type
    CHECK (check_type ~ '^[a-z][a-z0-9_-]{0,39}$'),
  -- Shorter than the plugin's interval, or set where the plugin has none.
  recheck_months integer CONSTRAINT background_check_club_requirements_months
    CHECK (recheck_months BETWEEN 1 AND 120),
  -- Only ever raised to required (a club is never weaker than the plugin).
  level text NOT NULL DEFAULT 'required' CONSTRAINT background_check_club_requirements_level
    CHECK (level = 'required'),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT background_check_club_requirements_unique UNIQUE (club_id, plugin_id, category, check_type)
);
-- Ended roles and group memberships by person (the overview's "listed for
-- deletion 12 months after the last role"): the person indexes cover open
-- ones only.
CREATE INDEX club_role_assignments_person_ended_idx ON public.club_role_assignments (person_id, club_id)
  WHERE valid_to IS NOT NULL;
CREATE INDEX group_memberships_person_ended_idx ON public.group_memberships (person_id, club_id)
  WHERE valid_to IS NOT NULL;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.background_check_club_requirements'),
  app.enable_updated_at('public.background_check_club_requirements'),
  history.enable_history('public.background_check_club_requirements');
--> statement-breakpoint

-- Whether a person is a child in the current club's country (the adult age
-- of its country pack): writing to a child needs a check (ADR 0047 rule 9).
CREATE FUNCTION app.is_child_in_club(p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p.birth_date > (now() AT TIME ZONE 'UTC')::date
      - make_interval(years => app.adult_age(c.country)), false)
  FROM public.people p, public.clubs c
  WHERE p.id = p_person AND c.id = app.current_club_id()
$$;
REVOKE ALL ON FUNCTION app.is_child_in_club(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_child_in_club(uuid) TO clubadmin_app;
--> statement-breakpoint

-- A new club's roles copy the requirement from the type's template.
CREATE OR REPLACE FUNCTION app.create_builtin_roles(p_club uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_previous text := app.setting('app.club_id');
  v_type uuid;
BEGIN
  SELECT club_type_id INTO v_type FROM public.clubs WHERE id = p_club;
  IF v_type IS NULL THEN
    v_type := (SELECT id FROM public.club_types WHERE key = 'sports_club');
  END IF;
  PERFORM set_config('app.club_id', p_club::text, true);
  INSERT INTO public.roles (club_id, scope, template_key, locked, names, descriptions, sort_order,
    background_check_category)
  SELECT p_club, t.scope, t.key, t.locked, t.names, t.descriptions, t.sort_order,
    t.background_check_category
  FROM public.club_type_roles t WHERE t.club_type_id = v_type
  ON CONFLICT (club_id, scope, template_key) WHERE template_key IS NOT NULL DO NOTHING;
  INSERT INTO public.role_permissions (club_id, role_id, permission)
  SELECT p_club, r.id, p.permission
  FROM public.club_type_roles t
  JOIN public.club_type_role_permissions p ON p.club_type_role_id = t.id
  JOIN public.roles r ON r.club_id = p_club AND r.scope = t.scope AND r.template_key = t.key
  WHERE t.club_type_id = v_type
  ON CONFLICT (role_id, permission) DO NOTHING;
  PERFORM set_config('app.club_id', coalesce(v_previous, ''), true);
END
$$;
--> statement-breakpoint

-- The template defaults: the coaches and the team manager.
UPDATE public.club_type_roles SET background_check_category = 'regular_contact_with_children'
WHERE scope = 'group' AND key IN ('head_coach', 'assistant_coach', 'team_manager');

DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs ORDER BY id LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    UPDATE public.roles SET background_check_category = 'regular_contact_with_children',
      version = version + 1
    WHERE club_id = v_club AND scope = 'group' AND background_check_category IS NULL
      AND template_key IN ('head_coach', 'assistant_coach', 'team_manager');
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.builtin_role_template()
  RETURNS TABLE (template_key text, scope text, permission text)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM (VALUES
    ('club_manager', 'club', 'club.settings.update'),
    ('club_manager', 'club', 'club.roles.manage'),
    ('club_manager', 'club', 'club.roles.read'),
    ('club_manager', 'club', 'club.people.protected'),
    ('club_manager', 'club', 'club.people.contact.edit'),
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
    ('registrar', 'club', 'club.people.contact.edit'),
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
    ('registrar', 'club', 'club.background_checks.verify'),
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
    ('safeguarding_officer', 'club', 'club.background_checks.verify'),
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
WHERE t.permission = 'club.background_checks.verify'
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
      WHERE t.permission = 'club.background_checks.verify'
      ON CONFLICT (role_id, permission) DO NOTHING
      RETURNING role_id)
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND id IN (SELECT role_id FROM added);
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
