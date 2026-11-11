-- Club-defined roles, part A1 (P1.15, ADR 0046): roles and their permissions
-- per club, instead of role and function names in code and SQL. Nothing
-- changes in behaviour: every club gets the built-in template (today's roles
-- with today's permissions) and every assignment points at its role.
--
-- Expand only: `club_role_assignments.role` and `group_memberships.function`
-- stay and keep being written by older code; triggers fill `role_id` (and
-- the group memberships' `participates` and `leads`) from them.

CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  scope text NOT NULL CONSTRAINT roles_scope CHECK (scope IN ('club', 'group')),
  -- The template role it comes from (`club_manager`, `head_coach`, ...); NULL for the club's own.
  template_key text,
  locked boolean NOT NULL DEFAULT false,
  -- Display names and descriptions per language ({"sv": ...}); NULL: the catalogue's text.
  names jsonb,
  descriptions jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT roles_club_id_unique UNIQUE (club_id, id)
);
CREATE UNIQUE INDEX roles_template_unique ON public.roles (club_id, scope, template_key)
  WHERE template_key IS NOT NULL;
CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT role_permissions_role_fk FOREIGN KEY (club_id, role_id)
    REFERENCES public.roles (club_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX role_permissions_unique ON public.role_permissions (role_id, permission);
-- "Who holds this permission in the club" (app.holds_permission, the worker's recipients).
CREATE INDEX role_permissions_club_permission_idx ON public.role_permissions (club_id, permission);
--> statement-breakpoint
SELECT app.enable_tenant_rls('public.roles'), app.enable_updated_at('public.roles'),
  history.enable_history('public.roles');
SELECT app.enable_tenant_rls('public.role_permissions'),
  app.enable_updated_at('public.role_permissions'), history.enable_history('public.role_permissions');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles, public.role_permissions TO clubadmin_app;
GRANT SELECT, UPDATE, DELETE ON public.roles, public.role_permissions TO clubadmin_retention;
--> statement-breakpoint

-- Assignments point at their role; group memberships carry whether the role
-- takes part in the group's activities and counts as its leader (read by hot
-- queries: My schedule, rosters, attendance, recipients).
ALTER TABLE public.club_role_assignments ADD COLUMN role_id uuid,
  ADD CONSTRAINT club_role_assignments_role_fk FOREIGN KEY (club_id, role_id)
    REFERENCES public.roles (club_id, id);
ALTER TABLE public.group_memberships ADD COLUMN role_id uuid,
  ADD COLUMN participates boolean NOT NULL DEFAULT false,
  ADD COLUMN leads boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT group_memberships_role_fk FOREIGN KEY (club_id, role_id)
    REFERENCES public.roles (club_id, id);
CREATE INDEX club_role_assignments_role_idx ON public.club_role_assignments (club_id, role_id)
  WHERE valid_to IS NULL;
CREATE INDEX group_memberships_role_idx ON public.group_memberships (club_id, role_id)
  WHERE valid_to IS NULL;
-- The relationship set (outside any club) reads the permissions of the
-- person's own roles and their wards' (like own_relationships).
-- By person (the assignments' person indexes), never by role.
CREATE POLICY own_roles ON public.role_permissions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.club_role_assignments r
      WHERE r.person_id = ANY ((SELECT app.self_and_wards())::uuid[]) AND r.valid_to IS NULL
        AND r.role_id = role_permissions.role_id)
    OR EXISTS (SELECT 1 FROM public.group_memberships gm
      WHERE gm.person_id = ANY ((SELECT app.self_and_wards())::uuid[]) AND gm.valid_to IS NULL
        AND gm.role_id = role_permissions.role_id)
  );
--> statement-breakpoint

-- The built-in template (the built-in club type "Idrottsförening"): today's
-- roles and functions as template keys, with the permissions they had. The
-- same table as BUILT_IN_ROLE_TEMPLATE in @clubadmin/shared (a test compares).
CREATE FUNCTION app.builtin_role_template()
  RETURNS TABLE (template_key text, scope text, permission text)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM (VALUES
    ('club_manager', 'club', 'club.people.details'),
    ('club_manager', 'club', 'club.people.protected'),
    ('club_manager', 'club', 'club.members.read'),
    ('club_manager', 'club', 'club.members.manage'),
    ('club_manager', 'club', 'club.members.export'),
    ('club_manager', 'club', 'club.members.add'),
    ('club_manager', 'club', 'club.members.import'),
    ('club_manager', 'club', 'club.join_requests.manage'),
    ('club_manager', 'club', 'club.invitations.manage'),
    ('club_manager', 'club', 'club.guardians.manage'),
    ('club_manager', 'club', 'club.waitlists.read'),
    ('club_manager', 'club', 'club.groups.archived.read'),
    ('club_manager', 'club', 'club.activities.read'),
    ('club_manager', 'club', 'group.members.read'),
    ('club_manager', 'club', 'group.activities.read'),
    ('club_manager', 'club', 'group.attendance.read'),
    ('club_manager', 'club', 'activity.attendance.manage'),
    ('club_manager', 'club', 'event.read'),
    ('club_manager', 'club', 'event.registrations.read'),
    ('club_manager', 'club', 'person.own_login.invite'),
    ('club_manager', 'club', 'person.consents.read'),
    ('club_manager', 'club', 'person.consents.manage'),
    ('club_manager', 'club', 'group.consents.read'),
    ('club_manager', 'club', 'person.history.read'),
    ('club_manager', 'club', 'group.history.read'),
    ('club_manager', 'club', 'activity.history.read'),
    ('club_manager', 'club', 'event.history.read'),
    ('club_manager', 'club', 'club.settings.update'),
    ('club_manager', 'club', 'club.roles.manage'),
    ('club_manager', 'club', 'club.groups.create'),
    ('club_manager', 'club', 'group.update'),
    ('club_manager', 'club', 'group.owners.manage'),
    ('club_manager', 'club', 'group.members.manage'),
    ('club_manager', 'club', 'group.waitlist.manage'),
    ('club_manager', 'club', 'group.activities.manage'),
    ('club_manager', 'club', 'club.locations.manage'),
    ('club_manager', 'club', 'club.locations.create'),
    ('club_manager', 'club', 'club.events.create'),
    ('club_manager', 'club', 'event.manage'),
    ('club_manager', 'club', 'person.protection.set'),
    ('club_manager', 'club', 'person.merge'),
    ('club_manager', 'club', 'club.guardianships.end'),
    ('club_manager', 'club', 'club.history.read'),
    ('club_manager', 'club', 'club.audit.read'),
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
    ('chair', 'club', 'club.members.read'),
    ('chair', 'club', 'club.activities.read'),
    ('chair', 'club', 'club.events.create'),
    ('chair', 'club', 'club.managers.claim'),
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

-- Creates a club's roles from the template (idempotent). Runs in the club's
-- tenant scope for its own statements, whoever creates the club.
CREATE FUNCTION app.create_builtin_roles(p_club uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_previous text := app.setting('app.club_id');
BEGIN
  PERFORM set_config('app.club_id', p_club::text, true);
  INSERT INTO public.roles (club_id, scope, template_key, locked, sort_order)
  SELECT p_club, t.scope, t.template_key, t.template_key IN ('club_manager', 'chair'),
    min(t.ord)
  FROM (SELECT x.*, row_number() OVER () AS ord FROM app.builtin_role_template() x) t
  GROUP BY t.scope, t.template_key
  ON CONFLICT (club_id, scope, template_key) WHERE template_key IS NOT NULL DO NOTHING;
  INSERT INTO public.role_permissions (club_id, role_id, permission)
  SELECT p_club, r.id, t.permission
  FROM app.builtin_role_template() t
  JOIN public.roles r ON r.club_id = p_club AND r.scope = t.scope AND r.template_key = t.template_key
  WHERE t.permission IS NOT NULL
  ON CONFLICT (role_id, permission) DO NOTHING;
  PERFORM set_config('app.club_id', coalesce(v_previous, ''), true);
END
$$;
REVOKE ALL ON FUNCTION app.create_builtin_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_builtin_roles(uuid) TO clubadmin_app;

CREATE FUNCTION app.clubs_create_roles() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.create_builtin_roles(NEW.id);
  RETURN NULL;
END
$$;
CREATE TRIGGER clubs_create_roles AFTER INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION app.clubs_create_roles();
--> statement-breakpoint

-- A template role's ID in a club, and whether a role takes part in or leads
-- a group (for the triggers below; in the club's tenant scope, whoever writes).
CREATE FUNCTION app.template_role_id(p_club uuid, p_scope text, p_key text) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_previous text := app.setting('app.club_id');
  v_id uuid;
BEGIN
  PERFORM set_config('app.club_id', p_club::text, true);
  SELECT r.id INTO v_id FROM public.roles r
  WHERE r.club_id = p_club AND r.scope = p_scope AND r.template_key = p_key;
  PERFORM set_config('app.club_id', coalesce(v_previous, ''), true);
  RETURN v_id;
END
$$;
CREATE FUNCTION app.role_holds(p_club uuid, p_role uuid, p_permission text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_previous text := app.setting('app.club_id');
  v_holds boolean;
BEGIN
  PERFORM set_config('app.club_id', p_club::text, true);
  v_holds := EXISTS (SELECT 1 FROM public.role_permissions rp
    WHERE rp.club_id = p_club AND rp.role_id = p_role AND rp.permission = p_permission);
  PERFORM set_config('app.club_id', coalesce(v_previous, ''), true);
  RETURN v_holds;
END
$$;
REVOKE ALL ON FUNCTION app.template_role_id(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.role_holds(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.template_role_id(uuid, text, text), app.role_holds(uuid, uuid, text)
  TO clubadmin_app;

-- Older writers name the role or function; newer ones (A2) the role.
CREATE FUNCTION app.club_role_assignments_role() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.role_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role
      AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id) THEN
    NEW.role_id := app.template_role_id(NEW.club_id, 'club', NEW.role);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER club_role_assignments_role BEFORE INSERT OR UPDATE OF role, role_id
  ON public.club_role_assignments FOR EACH ROW EXECUTE FUNCTION app.club_role_assignments_role();

CREATE FUNCTION app.group_memberships_role() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.role_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.function IS DISTINCT FROM OLD.function
      AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id) THEN
    NEW.role_id := app.template_role_id(NEW.club_id, 'group', NEW.function);
  END IF;
  NEW.participates := coalesce(app.role_holds(NEW.club_id, NEW.role_id, 'group.participate'), false);
  NEW.leads := coalesce(app.role_holds(NEW.club_id, NEW.role_id, 'group.lead'), false);
  RETURN NEW;
END
$$;
CREATE TRIGGER group_memberships_role BEFORE INSERT OR UPDATE OF function, role_id
  ON public.group_memberships FOR EACH ROW EXECUTE FUNCTION app.group_memberships_role();

-- A role gains or loses taking part or leading (A2): its memberships follow.
CREATE FUNCTION app.role_permissions_flags() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row public.role_permissions := coalesce(NEW, OLD);
  v_holds boolean := TG_OP = 'INSERT';
BEGIN
  IF v_row.permission = 'group.participate' THEN
    UPDATE public.group_memberships SET participates = v_holds
    WHERE club_id = v_row.club_id AND role_id = v_row.role_id AND participates <> v_holds;
  ELSIF v_row.permission = 'group.lead' THEN
    UPDATE public.group_memberships SET leads = v_holds
    WHERE club_id = v_row.club_id AND role_id = v_row.role_id AND leads <> v_holds;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER role_permissions_flags AFTER INSERT OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION app.role_permissions_flags();
--> statement-breakpoint

-- Every existing club: its roles, then its assignments, club by club in the
-- club's tenant scope (the tables are forced under RLS for the migration too).
DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs ORDER BY id LOOP
    PERFORM app.create_builtin_roles(v_club);
    PERFORM set_config('app.club_id', v_club::text, true);
    UPDATE public.club_role_assignments a SET role_id = r.id
    FROM public.roles r
    WHERE a.club_id = v_club AND a.role_id IS NULL
      AND r.club_id = v_club AND r.scope = 'club' AND r.template_key = a.role;
    UPDATE public.group_memberships gm SET role_id = r.id
    FROM public.roles r
    WHERE gm.club_id = v_club AND gm.role_id IS NULL
      AND r.club_id = v_club AND r.scope = 'group' AND r.template_key = gm.function;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint

-- Whether the current person holds a permission in a club (through a club
-- role) or in a group of it (a club role, or a role held in the group).
-- Group permissions are not inherited by child groups (P1.15 decision 13).
CREATE FUNCTION app.holds_permission(p_club uuid, p_permission text, p_group uuid DEFAULT NULL)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.current_person_id() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.club_role_assignments r
      JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.role_id
      WHERE r.club_id = p_club AND r.person_id = app.current_person_id() AND r.valid_to IS NULL
        AND rp.permission = p_permission)
    OR (p_group IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.group_memberships gm
      JOIN public.role_permissions rp ON rp.club_id = gm.club_id AND rp.role_id = gm.role_id
      WHERE gm.club_id = p_club AND gm.group_id = p_group
        AND gm.person_id = app.current_person_id() AND gm.valid_to IS NULL
        AND rp.permission = p_permission)))
$$;
GRANT EXECUTE ON FUNCTION app.holds_permission(uuid, text, uuid) TO clubadmin_app;
--> statement-breakpoint

-- Row-level security asks for permissions instead of role names.
DO $billing$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing.subscriptions', 'billing.invoices', 'billing.invoice_lines',
      'billing.accounts', 'billing.payments'] LOOP
    EXECUTE format('DROP POLICY billing_readers ON %s', t);
    EXECUTE format(
      'CREATE POLICY billing_readers ON %s AS RESTRICTIVE FOR SELECT TO clubadmin_app '
      'USING (app.is_system() OR app.is_platform_operator() '
      'OR app.holds_permission(app.current_club_id(), ''billing.invoices.read''))', t);
  END LOOP;
END
$billing$;
DROP POLICY billing_writers ON billing.accounts;
CREATE POLICY billing_writers ON billing.accounts AS RESTRICTIVE FOR INSERT TO clubadmin_app
  WITH CHECK (app.is_system() OR app.is_platform_operator()
    OR app.holds_permission(app.current_club_id(), 'billing.account.manage'));
DROP POLICY billing_updaters ON billing.accounts;
CREATE POLICY billing_updaters ON billing.accounts AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator()
    OR app.holds_permission(app.current_club_id(), 'billing.account.manage'));
DROP POLICY billing_updaters ON billing.subscriptions;
CREATE POLICY billing_updaters ON billing.subscriptions AS RESTRICTIVE FOR UPDATE TO clubadmin_app
  USING (app.is_system() OR app.is_platform_operator()
    OR app.holds_permission(app.current_club_id(), 'billing.subscription.change'));
DROP POLICY invitation_access ON public.guardian_invitations;
CREATE POLICY invitation_access ON public.guardian_invitations
  USING (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
    OR (club_id IS NOT NULL AND club_id = app.current_club_id()
      AND app.holds_permission(club_id, 'club.guardians.manage'))
  )
  WITH CHECK (
    app.is_system() OR invited_by_person_id = app.current_person_id()
    OR ward_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id)
    OR (club_id IS NOT NULL AND club_id = app.current_club_id()
      AND app.holds_permission(club_id, 'club.guardians.manage'))
  );
--> statement-breakpoint

-- Functions that counted `member` rows count those who take part; erasure
-- lists the leader assignments.
CREATE OR REPLACE FUNCTION app.group_places(p_group_id uuid)
 RETURNS TABLE(capacity integer, occupied integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce((
      SELECT gs.capacity FROM public.group_seasons gs
      JOIN public.seasons s ON s.id = gs.season_id
      WHERE gs.group_id = g.id
        AND s.starts_on <= (now() AT TIME ZONE c.time_zone)::date
        AND s.ends_on >= (now() AT TIME ZONE c.time_zone)::date
      ORDER BY s.starts_on DESC LIMIT 1), g.capacity),
    (SELECT count(*)::int FROM public.group_memberships gm
      WHERE gm.club_id = g.club_id AND gm.group_id = g.id AND gm.valid_to IS NULL
        AND gm.participates)
    + (SELECT count(*)::int FROM public.group_waitlist_entries w
      WHERE w.group_id = g.id AND w.status IN ('offered', 'accepted'))
  FROM public.groups g JOIN public.clubs c ON c.id = g.club_id
  WHERE g.id = p_group_id
$function$;

CREATE OR REPLACE FUNCTION app.erasure_assignments(p_people uuid[])
 RETURNS TABLE(person_id uuid, club_id uuid, club_name text, kind text, assignment_id uuid, role text, group_id uuid, group_name text, group_function text, last_manager boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
    WHERE g.person_id IN (SELECT p FROM people) AND g.valid_to IS NULL AND g.leads
    UNION ALL
    SELECT o.person_id, o.club_id, 'group_owner', o.id, NULL, o.group_id, NULL, false
    FROM public.group_owners o
    WHERE o.person_id IN (SELECT p FROM people) AND o.valid_to IS NULL)
  SELECT f.person_id, f.club_id, (SELECT c.name FROM public.clubs c WHERE c.id = f.club_id),
    f.kind, f.id, f.role, f.group_id,
    (SELECT gr.name FROM public.groups gr WHERE gr.id = f.group_id), f.group_function,
    f.last_manager
  FROM facts f
$function$;
