CREATE TABLE "member_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"columns" text[] NOT NULL,
	"include_protected" boolean DEFAULT false NOT NULL,
	"row_count" integer,
	"object_key" text,
	"expires_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_exports_status" CHECK ("member_exports"."status" IN ('queued', 'ready', 'failed', 'expired')),
	CONSTRAINT "member_exports_columns" CHECK ("member_exports"."columns" <@ ARRAY['name', 'memberNumber', 'birthDate', 'gender', 'status', 'membershipType', 'joinedOn', 'leftOn', 'groups', 'roles', 'phone', 'address', 'guardians', 'missingConsents']::text[]),
	CONSTRAINT "member_exports_ready" CHECK ("member_exports"."status" <> 'ready' OR ("member_exports"."object_key" IS NOT NULL AND "member_exports"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "member_exports" ADD CONSTRAINT "member_exports_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_exports" ADD CONSTRAINT "member_exports_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_exports_club_idx" ON "member_exports" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE INDEX "member_exports_requester_idx" ON "member_exports" USING btree ("requested_by_person_id","created_at");--> statement-breakpoint
CREATE INDEX "member_exports_open_idx" ON "member_exports" USING btree ("expires_at") WHERE "member_exports"."status" IN ('queued', 'ready');--> statement-breakpoint
CREATE INDEX "club_memberships_register_idx" ON "club_memberships" USING btree ("club_id","status","membership_type");--> statement-breakpoint
CREATE INDEX "club_memberships_joined_idx" ON "club_memberships" USING btree ("club_id","valid_from","id");--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.2): the member register and its exports.
-------------------------------------------------------------------------------

-- Club-owned: tenant isolation, updated_at, history. Exports are kept as a
-- record (status expired) after their file is deleted.
SELECT app.enable_tenant_rls('public.member_exports'),
  app.enable_updated_at('public.member_exports'),
  history.enable_history('public.member_exports');
REVOKE DELETE ON public.member_exports FROM clubadmin_app, clubadmin_operator;
-- The worker finds exports to expire across clubs (IDs and object keys only),
-- then works on each in its club's context.
CREATE POLICY system_read ON public.member_exports FOR SELECT USING (app.is_system());
--> statement-breakpoint

-- Search as you type: part of "given family" name, through the club's
-- profiles (member numbers use club_profiles_member_number_unique).
CREATE INDEX people_name_trgm_idx ON public.people
  USING gin (lower(given_name || ' ' || family_name) public.gin_trgm_ops);
--> statement-breakpoint

-- The register: one row per person who is or was a member of the club, with
-- their current membership (or their last one if they left; `applied` is
-- legacy and never listed). sort_name and search_name order and match by
-- name without the query selecting names; names leave the API only through
-- the PersonPresenter (ADR 0022).
--
-- The view runs with its owner's rights (no security_invoker): people is
-- reached only through the club's memberships and profiles, which stay under
-- tenant row-level security (forced, also for the owner). That is the same
-- set people's own policy grants in a club context (members of the current
-- club), without evaluating app.can_see_person for every member of a
-- 10,000-member club (docs/performance.md).
--
-- `visible` is the database backstop for pages of the register (ADR 0022,
-- like app.visible_group_members): protected people only for viewers who are
-- privileged for the transaction (managers and registrars), themselves and
-- their guardians. Counts may include the others (without identity).
CREATE VIEW app.register_entries AS
SELECT m.club_id, m.person_id, m.id AS membership_id, m.status, m.membership_type,
       m.valid_from, m.valid_to, cp.member_number, cp.shared_fields, p.birth_date, p.gender,
       lower(p.family_name) || ' ' || lower(p.given_name) AS sort_name,
       lower(p.given_name || ' ' || p.family_name) AS search_name,
       coalesce(p.protected_identity OR cp.protected_identity_club, true) AS is_protected,
       (app.viewer_privileged()
         OR NOT coalesce(p.protected_identity OR cp.protected_identity_club, true)
         OR m.person_id = ANY ((SELECT app.self_and_wards())::uuid[])) AS visible
FROM public.club_memberships m
-- Every membership has its profile and person (foreign key; a membership
-- creates the profile). Outer joins on unique keys let the planner leave
-- them out of counts that do not need their columns.
LEFT JOIN public.club_profiles cp ON cp.club_id = m.club_id AND cp.person_id = m.person_id
LEFT JOIN public.people p ON p.id = m.person_id
WHERE m.status <> 'applied'
  AND (m.valid_to IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.club_memberships later
    WHERE later.club_id = m.club_id AND later.person_id = m.person_id
      AND later.status <> 'applied' AND later.id <> m.id
      AND (later.valid_to IS NULL OR (later.valid_from, later.id) > (m.valid_from, m.id))
  ));
REVOKE ALL ON app.register_entries FROM PUBLIC;
GRANT SELECT ON app.register_entries TO clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- A requested export becomes a worker job in the same transaction (like the
-- outbox): the CSV is generated outside the request.
CREATE FUNCTION app.enqueue_member_export() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'members:export',
    json_build_object('exportId', NEW.id, 'clubId', NEW.club_id),
    job_key := 'members:export:' || NEW.id::text,
    max_attempts := 5
  );
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.enqueue_member_export() FROM PUBLIC;
CREATE TRIGGER enqueue_export AFTER INSERT ON public.member_exports
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_member_export();
