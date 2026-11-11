-- Club-defined roles, part A2 (P1.15, ADR 0046): roles become editable.
--
-- - The club manager administers the club and access, not the day-to-day
--   work of other roles (maintainer's decision 2026-11-08): the register's
--   details, membership changes, guardians, consents, member history and
--   locked attendance move to the registrar. Its locked permissions are
--   club.roles.manage and club.people.protected (decision 2026-11-11).
--   Every club's managers are told (an outbox event per club).
-- - club.roles.read: the roles page and who holds what (managers,
--   registrars, the chair).
-- - Assignments name their role (role_id NOT NULL); clubs' own roles have no
--   template key, so the old role/function columns get a stand-in for older
--   readers (ADR 0029) and uniqueness moves to the role.

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
    ('vice_chair', 'club', 'club.members.read'),
    ('vice_chair', 'club', 'club.activities.read'),
    ('vice_chair', 'club', 'club.events.create'),
    ('treasurer', 'club', 'club.members.read'),
    ('treasurer', 'club', 'club.activities.read'),
    ('treasurer', 'club', 'club.events.create'),
    ('treasurer', 'club', 'billing.subscription.read'),
    ('treasurer', 'club', 'billing.account.manage'),
    ('treasurer', 'club', 'billing.invoices.read'),
    ('secretary', 'club', 'club.members.read'),
    ('secretary', 'club', 'club.activities.read'),
    ('secretary', 'club', 'club.events.create'),
    ('board_member', 'club', 'club.members.read'),
    ('board_member', 'club', 'club.activities.read'),
    ('board_member', 'club', 'club.events.create'),
    ('deputy_board_member', 'club', 'club.members.read'),
    ('deputy_board_member', 'club', 'club.activities.read'),
    ('deputy_board_member', 'club', 'club.events.create'),
    ('auditor', 'club', NULL),
    ('nomination_committee', 'club', NULL),
    ('safeguarding_officer', 'club', NULL),
    ('communications', 'club', NULL),
    ('staff', 'club', NULL),
    ('member', 'group', 'group.participate'),
    ('head_coach', 'group', 'group.lead'),
    ('head_coach', 'group', 'group.people.details'),
    ('head_coach', 'group', 'person.consents.read'),
    ('head_coach', 'group', 'group.consents.read'),
    ('head_coach', 'group', 'group.activities.manage'),
    ('head_coach', 'group', 'activity.responses.read'),
    ('assistant_coach', 'group', 'group.lead'),
    ('assistant_coach', 'group', 'group.people.details'),
    ('assistant_coach', 'group', 'person.consents.read'),
    ('assistant_coach', 'group', 'group.consents.read'),
    ('assistant_coach', 'group', 'group.activities.manage'),
    ('assistant_coach', 'group', 'activity.responses.read'),
    ('team_manager', 'group', 'group.lead'),
    ('team_manager', 'group', 'group.people.details'),
    ('team_manager', 'group', 'person.consents.read'),
    ('team_manager', 'group', 'group.consents.read'),
    ('team_manager', 'group', 'group.activities.manage'),
    ('team_manager', 'group', 'activity.responses.read'),
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

DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs ORDER BY id LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    DELETE FROM public.role_permissions rp USING public.roles r
    WHERE rp.club_id = v_club AND r.id = rp.role_id AND r.template_key = 'club_manager'
      AND r.scope = 'club'
      AND rp.permission IN ('club.people.details','club.members.manage','club.members.export','club.members.add','club.members.import','club.guardians.manage','group.attendance.read','activity.attendance.manage','event.registrations.read','person.own_login.invite','person.consents.read','person.consents.manage','group.consents.read','person.history.read');
    INSERT INTO public.role_permissions (club_id, role_id, permission)
    SELECT v_club, r.id, t.permission
    FROM app.builtin_role_template() t
    JOIN public.roles r ON r.club_id = v_club AND r.scope = t.scope AND r.template_key = t.template_key
    WHERE t.permission IN ('club.roles.read', 'club.people.protected')
    ON CONFLICT (role_id, permission) DO NOTHING;
    UPDATE public.roles SET version = version + 1
    WHERE club_id = v_club AND template_key IN ('club_manager', 'registrar', 'chair');
    INSERT INTO outbox.events (id, type, club_id, payload, idempotency_key)
    VALUES (uuidv7(), 'roles.manager_split', v_club,
      jsonb_build_object('clubId', v_club), 'roles.manager_split:' || v_club)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- A role's facts for the assignment triggers: its ID (by ID, or by the
-- template key older writers name), scope, template key, and whether it
-- takes part and leads.
CREATE FUNCTION app.role_facts(p_club uuid, p_scope text, p_role uuid, p_key text,
    OUT role_id uuid, OUT scope text, OUT template_key text,
    OUT participates boolean, OUT leads boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_previous text := app.setting('app.club_id');
BEGIN
  PERFORM set_config('app.club_id', p_club::text, true);
  SELECT r.id, r.scope, r.template_key,
    coalesce(bool_or(rp.permission = 'group.participate'), false),
    coalesce(bool_or(rp.permission = 'group.lead'), false)
  INTO role_id, scope, template_key, participates, leads
  FROM public.roles r
  LEFT JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.id
    AND rp.permission IN ('group.participate', 'group.lead')
  WHERE r.club_id = p_club
    AND (CASE WHEN p_role IS NOT NULL THEN r.id = p_role
         ELSE r.scope = p_scope AND r.template_key = p_key END)
  GROUP BY r.id, r.scope, r.template_key;
  PERFORM set_config('app.club_id', coalesce(v_previous, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.role_facts(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.role_facts(uuid, text, uuid, text) TO clubadmin_app;

-- Older writers name the template key; newer ones the role, whose template
-- key (or a stand-in for a club's own role) fills the old column.
CREATE OR REPLACE FUNCTION app.club_role_assignments_role() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role record;
BEGIN
  IF NEW.role_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role
      AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id) THEN
    v_role := app.role_facts(NEW.club_id, 'club', NULL, NEW.role);
  ELSE
    v_role := app.role_facts(NEW.club_id, 'club', NEW.role_id, NULL);
    NEW.role := coalesce(v_role.template_key, 'staff');
  END IF;
  IF v_role.role_id IS NULL OR v_role.scope <> 'club' THEN
    RAISE EXCEPTION 'not a club role of the club' USING ERRCODE = '23514';
  END IF;
  NEW.role_id := v_role.role_id;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.group_memberships_role() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role record;
BEGIN
  IF NEW.role_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.function IS DISTINCT FROM OLD.function
      AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id) THEN
    v_role := app.role_facts(NEW.club_id, 'group', NULL, NEW.function);
  ELSE
    v_role := app.role_facts(NEW.club_id, 'group', NEW.role_id, NULL);
    NEW.function := coalesce(v_role.template_key,
      CASE WHEN v_role.participates THEN 'member' ELSE 'other_leader' END);
  END IF;
  IF v_role.role_id IS NULL OR v_role.scope <> 'group' THEN
    RAISE EXCEPTION 'not a group role of the club' USING ERRCODE = '23514';
  END IF;
  NEW.role_id := v_role.role_id;
  NEW.participates := v_role.participates;
  NEW.leads := v_role.leads;
  RETURN NEW;
END
$$;
DROP FUNCTION app.role_of(uuid, text, uuid, text);
--> statement-breakpoint

ALTER TABLE public.club_role_assignments
  -- expand-contract: backfilled by 0030; the trigger fills it for every writer
  ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE public.group_memberships
  -- expand-contract: backfilled by 0030; the trigger fills it for every writer
  ALTER COLUMN role_id SET NOT NULL;
-- One open assignment per person and role (a club's own roles share stand-in keys).
DROP INDEX public.club_role_assignments_open_unique;
CREATE UNIQUE INDEX club_role_assignments_open_unique
  ON public.club_role_assignments (club_id, person_id, role_id) WHERE valid_to IS NULL;
DROP INDEX public.group_memberships_open_unique;
CREATE UNIQUE INDEX group_memberships_open_unique
  ON public.group_memberships (group_id, person_id, role_id) WHERE valid_to IS NULL;
