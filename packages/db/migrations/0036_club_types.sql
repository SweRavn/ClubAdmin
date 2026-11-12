-- Club types and their templates, part B (P1.15, ADR 0046): a club type has a
-- template of roles with permissions; a new club gets a copy of its type's
-- roles. The built-in type "Idrottsförening" is today's template
-- (app.builtin_role_template()). Templates never change clubs by themselves
-- (decision 6).
--
-- Global tables (no club_id, ADR 0023): everyone logged in reads them (the
-- club creation form), operators and system jobs write them.

CREATE TABLE public.club_types (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  key text NOT NULL CONSTRAINT club_types_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Names and the one sentence per language ({"sv": ...}).
  names jsonb NOT NULL,
  descriptions jsonb,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT club_types_key_unique UNIQUE (key)
);
CREATE TABLE public.club_type_roles (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_type_id uuid NOT NULL REFERENCES public.club_types(id),
  -- The template key the club's role gets (`club_manager`, `member`, `tournament_director`).
  key text NOT NULL CONSTRAINT club_type_roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  scope text NOT NULL CONSTRAINT club_type_roles_scope CHECK (scope IN ('club', 'group')),
  -- NULL: the catalogue's name for the key (known keys only).
  names jsonb,
  descriptions jsonb,
  locked boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT club_type_roles_key_unique UNIQUE (club_type_id, scope, key)
);
CREATE TABLE public.club_type_role_permissions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_type_role_id uuid NOT NULL REFERENCES public.club_type_roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT club_type_role_permissions_unique UNIQUE (club_type_role_id, permission)
);
--> statement-breakpoint

ALTER TABLE public.club_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_type_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_type_role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalogue_read ON public.club_types FOR SELECT
  USING (app.current_person_id() IS NOT NULL OR app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_read ON public.club_type_roles FOR SELECT
  USING (app.current_person_id() IS NOT NULL OR app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_read ON public.club_type_role_permissions FOR SELECT
  USING (app.current_person_id() IS NOT NULL OR app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_insert ON public.club_types FOR INSERT
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_insert ON public.club_type_roles FOR INSERT
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_insert ON public.club_type_role_permissions FOR INSERT
  WITH CHECK (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_update ON public.club_types FOR UPDATE
  USING (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_update ON public.club_type_roles FOR UPDATE
  USING (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_update ON public.club_type_role_permissions FOR UPDATE
  USING (app.is_system() OR app.is_platform_operator());
-- A type is deactivated, never deleted; its roles and their permissions are.
CREATE POLICY catalogue_delete ON public.club_type_roles FOR DELETE
  USING (app.is_system() OR app.is_platform_operator());
CREATE POLICY catalogue_delete ON public.club_type_role_permissions FOR DELETE
  USING (app.is_system() OR app.is_platform_operator());
REVOKE DELETE ON public.club_types FROM clubadmin_app, clubadmin_operator;
SELECT app.enable_updated_at('public.club_types'), history.enable_history('public.club_types');
SELECT app.enable_updated_at('public.club_type_roles'),
  history.enable_history('public.club_type_roles');
SELECT app.enable_updated_at('public.club_type_role_permissions'),
  history.enable_history('public.club_type_role_permissions');
--> statement-breakpoint

-- The built-in type: today's template, in the template's order. Names of
-- known keys come from the message catalogue (NULL).
INSERT INTO public.club_types (key, names, descriptions, sort_order) VALUES (
  'sports_club',
  '{"sv": "Idrottsförening", "en": "Sports club", "nb": "Idrettslag"}',
  '{"sv": "Styrelse, medlemsansvariga, lag och träningsgrupper med tränare och ledare.",
    "en": "A board, registrars, teams and training groups with coaches and leaders.",
    "nb": "Styre, medlemsansvarlige, lag og treningsgrupper med trenere og ledere."}',
  0);
INSERT INTO public.club_type_roles (club_type_id, key, scope, locked, sort_order)
SELECT ct.id, t.template_key, t.scope, t.template_key IN ('club_manager', 'chair'), min(t.ord)
FROM public.club_types ct,
  (SELECT x.*, row_number() OVER () AS ord FROM app.builtin_role_template() x) t
WHERE ct.key = 'sports_club'
GROUP BY ct.id, t.scope, t.template_key;
INSERT INTO public.club_type_role_permissions (club_type_role_id, permission)
SELECT r.id, t.permission
FROM app.builtin_role_template() t
JOIN public.club_type_roles r ON r.scope = t.scope AND r.key = t.template_key
JOIN public.club_types ct ON ct.id = r.club_type_id AND ct.key = 'sports_club'
WHERE t.permission IS NOT NULL;
--> statement-breakpoint

-- The club's type (for statistics and later templates); every existing club
-- has the built-in one, a club inserted without one gets it too.
ALTER TABLE public.clubs ADD COLUMN club_type_id uuid REFERENCES public.club_types(id);
ALTER TABLE public.club_creation_requests ADD COLUMN club_type_id uuid
  REFERENCES public.club_types(id);
CREATE INDEX clubs_club_type_idx ON public.clubs (club_type_id);
UPDATE public.clubs SET club_type_id = (SELECT id FROM public.club_types WHERE key = 'sports_club')
WHERE club_type_id IS NULL;

CREATE FUNCTION app.clubs_default_type() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.club_type_id IS NULL THEN
    NEW.club_type_id := (SELECT id FROM public.club_types WHERE key = 'sports_club');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER clubs_default_type BEFORE INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION app.clubs_default_type();
--> statement-breakpoint

-- A new club's roles: a copy of its type's template (names, descriptions,
-- locked, order, permissions), in the club's tenant scope whoever creates it.
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
  INSERT INTO public.roles (club_id, scope, template_key, locked, names, descriptions, sort_order)
  SELECT p_club, t.scope, t.key, t.locked, t.names, t.descriptions, t.sort_order
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

-- The old columns' CHECK lists name today's keys only: a type's own key
-- (`tournament_director`) falls back as a club's own role does.
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
    NEW.role := CASE WHEN v_role.template_key IN ('chair', 'vice_chair', 'treasurer',
        'secretary', 'board_member', 'deputy_board_member', 'auditor', 'nomination_committee',
        'club_manager', 'registrar', 'safeguarding_officer', 'communications')
      THEN v_role.template_key ELSE 'staff' END;
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
    NEW.function := CASE
      WHEN v_role.template_key IN ('member', 'head_coach', 'assistant_coach', 'team_manager',
        'physio', 'other_leader') THEN v_role.template_key
      WHEN v_role.participates THEN 'member' ELSE 'other_leader' END;
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
