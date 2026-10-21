CREATE TABLE "platform_operators" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_operators_valid_period" CHECK ("platform_operators"."valid_to" IS NULL OR "platform_operators"."valid_to" > "platform_operators"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "support_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"operator_person_id" uuid NOT NULL,
	"granted_by_person_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_access_grants_expiry" CHECK ("support_access_grants"."expires_at" > "support_access_grants"."created_at")
);
--> statement-breakpoint
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_operator_person_id_people_id_fk" FOREIGN KEY ("operator_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_granted_by_person_id_people_id_fk" FOREIGN KEY ("granted_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_revoked_by_person_id_people_id_fk" FOREIGN KEY ("revoked_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_operators_open_unique" ON "platform_operators" USING btree ("person_id") WHERE "platform_operators"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "support_access_grants_operator_idx" ON "support_access_grants" USING btree ("operator_person_id") WHERE "support_access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "support_access_grants_club_idx" ON "support_access_grants" USING btree ("club_id","expires_at");--> statement-breakpoint
CREATE INDEX "club_profiles_protected_idx" ON "club_profiles" USING btree ("club_id") WHERE "club_profiles"."protected_identity_club";--> statement-breakpoint
CREATE INDEX "people_protected_idx" ON "people" USING btree ("id") WHERE "people"."protected_identity";--> statement-breakpoint
-------------------------------------------------------------------------------
-- Hand-written part (P0.7, authorization and person visibility).
-------------------------------------------------------------------------------

-- Platform operators: readable by the operator themselves (relationship set)
-- and by jobs; written only through operator tooling (clubadmin_operator).
ALTER TABLE public.platform_operators ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_read ON public.platform_operators FOR SELECT
  USING (app.is_system() OR person_id = app.current_person_id());
CREATE POLICY operator_tooling ON public.platform_operators TO clubadmin_operator
  USING (true) WITH CHECK (true);
CREATE POLICY retention_access ON public.platform_operators TO clubadmin_retention USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON public.platform_operators FROM clubadmin_app;
REVOKE DELETE ON public.platform_operators FROM clubadmin_operator;
SELECT app.enable_updated_at('public.platform_operators'), history.enable_history('public.platform_operators');
--> statement-breakpoint

-- Support access grants belong to the club that granted them; the operator
-- reads their own grants across clubs (relationship set). Grants are revoked
-- or expire, never deleted.
SELECT app.enable_tenant_rls('public.support_access_grants'),
  app.enable_updated_at('public.support_access_grants'),
  history.enable_history('public.support_access_grants');
CREATE POLICY own_relationships ON public.support_access_grants FOR SELECT
  USING (operator_person_id = app.current_person_id());
REVOKE DELETE ON public.support_access_grants FROM clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- The acting person and their wards (active guardianships), evaluated once
-- per statement when wrapped in a subquery: (SELECT app.self_and_wards()).
-- Lets policies use the person_id indexes instead of calling a function per row.
CREATE FUNCTION app.self_and_wards() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE WHEN app.current_person_id() IS NULL THEN '{}'::uuid[]
    ELSE array_prepend(app.current_person_id(),
      coalesce(array_agg(g.ward_person_id) FILTER (WHERE g.ward_person_id IS NOT NULL), '{}'))
  END
  FROM public.guardianships g
  WHERE g.guardian_person_id = app.current_person_id() AND g.status = 'active' AND g.valid_to IS NULL
$$;
--> statement-breakpoint

-- The acting person has a current relationship with the club: an active or
-- paused membership, a club role, a current employment, unexpired support
-- access, or a ward who is an active or paused member. Reads only rows the
-- own_relationships policies already expose (SECURITY INVOKER); every probe
-- uses a (club_id, person_id) or person_id index. One statement at a time,
-- cheapest first (an expression with several subqueries is planned again on
-- every call).
CREATE FUNCTION app.has_club_relationship(p_club uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $$
DECLARE
  v_me uuid := app.current_person_id();
BEGIN
  IF v_me IS NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_memberships m
    WHERE m.club_id = p_club AND m.person_id = ANY (app.self_and_wards())
      AND m.valid_to IS NULL AND m.status IN ('active', 'paused')
  ) THEN
    RETURN true;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_role_assignments r
    WHERE r.club_id = p_club AND r.person_id = v_me AND r.valid_to IS NULL
  ) THEN
    RETURN true;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.employments e
    WHERE e.club_id = p_club AND e.person_id = v_me
      AND e.starts_on <= current_date AND (e.ends_on IS NULL OR e.ends_on >= current_date)
  ) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.support_access_grants s
    WHERE s.club_id = p_club AND s.operator_person_id = v_me
      AND s.revoked_at IS NULL AND s.expires_at > now()
  );
END
$$;
--> statement-breakpoint

-- People with a relationship to a club see its record and its groups (club
-- structure, not personal data); which groups and members an endpoint shows
-- is decided by the authorization module. Needed to resolve a group's club
-- before the request knows it (GET /groups/:groupId).
CREATE POLICY insider_read ON public.clubs FOR SELECT USING (app.has_club_relationship(id));
CREATE POLICY insider_read ON public.groups FOR SELECT USING (app.has_club_relationship(club_id));
--> statement-breakpoint

-- The member_read policies of 0001 called a function for every membership
-- row of the club (clubs) or of the whole database (groups: a hashed subplan
-- over all open group memberships). clubs keeps applicants (any open
-- membership, for "my clubs"), now through the person index; groups are
-- covered by insider_read (group members are active or paused club members).
DROP POLICY member_read ON public.clubs;
CREATE POLICY member_read ON public.clubs FOR SELECT
  USING (id IN (
    SELECT m.club_id FROM public.club_memberships m
    WHERE m.person_id = ANY ((SELECT app.self_and_wards())::uuid[]) AND m.valid_to IS NULL
  ));
DROP POLICY member_read ON public.groups;
--> statement-breakpoint

-- Same rules as 0001, checked one statement at a time, cheapest first: the
-- common case in a club transaction (a member of the club) is one index
-- probe. As one expression (0001) every call planned all six subqueries
-- again, about 0.2 ms per row.
CREATE OR REPLACE FUNCTION app.can_see_person(p_person uuid, p_created_by uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_me uuid := app.current_person_id();
  v_club uuid := app.current_club_id();
BEGIN
  IF app.is_system() OR p_person = v_me OR p_created_by = v_me THEN
    RETURN true;
  END IF;
  IF v_club IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_profiles cp WHERE cp.club_id = v_club AND cp.person_id = p_person
  ) THEN
    RETURN true;
  END IF;
  -- Family: the person's guardian, ward or co-guardian.
  IF v_me IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.guardianships g
      WHERE g.guardian_person_id = v_me AND g.ward_person_id = p_person
        AND g.status = 'active' AND g.valid_to IS NULL
    ) THEN
      RETURN true;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.guardianships g
      WHERE g.ward_person_id = v_me AND g.guardian_person_id = p_person
        AND g.status = 'active' AND g.valid_to IS NULL
    ) THEN
      RETURN true;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.guardianships mine
      JOIN public.guardianships other ON other.ward_person_id = mine.ward_person_id
      WHERE mine.guardian_person_id = v_me AND other.guardian_person_id = p_person
        AND mine.status = 'active' AND mine.valid_to IS NULL
        AND other.status = 'active' AND other.valid_to IS NULL
    ) THEN
      RETURN true;
    END IF;
  END IF;
  IF v_club IS NULL THEN
    RETURN false;
  END IF;
  -- The current club's members' guardians and join applicants.
  IF EXISTS (
    SELECT 1 FROM public.guardianships g
    JOIN public.club_profiles cp ON cp.person_id = g.ward_person_id AND cp.club_id = v_club
    WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL
  ) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.join_requests jr
    WHERE jr.club_id = v_club AND (jr.person_id = p_person OR jr.requested_by_person_id = p_person)
  );
END
$$;
--> statement-breakpoint

-- Set by the authorization module (withTenant viewerPrivileged) when the
-- viewer may see protected persons in the list being read (ADR 0022).
CREATE FUNCTION app.viewer_privileged() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT coalesce(app.setting('app.viewer_privileged') = 'on', false) $$;
--> statement-breakpoint

-- Database backstop for member-facing lists (ADR 0022): active group
-- memberships without protected persons, unless the viewer is privileged for
-- the transaction, the person is the viewer, or the viewer is their guardian.
-- sort_name orders lists by name without the query selecting names; names
-- leave the API only through the PersonPresenter.
CREATE VIEW app.visible_group_members WITH (security_invoker = true, security_barrier = true) AS
SELECT gm.id, gm.club_id, gm.group_id, gm.person_id, gm.function, gm.valid_from,
       lower(p.family_name) || ' ' || lower(p.given_name) AS sort_name
FROM public.group_memberships gm
JOIN public.people p ON p.id = gm.person_id
LEFT JOIN public.club_profiles cp ON cp.club_id = gm.club_id AND cp.person_id = gm.person_id
WHERE gm.valid_to IS NULL AND (
  app.viewer_privileged()
  OR NOT (p.protected_identity OR coalesce(cp.protected_identity_club, false))
  OR gm.person_id = ANY ((SELECT app.self_and_wards())::uuid[])
);
GRANT SELECT ON app.visible_group_members TO clubadmin_app, clubadmin_operator;
