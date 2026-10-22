CREATE TABLE "club_creation_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"slug" text NOT NULL,
	"country" text NOT NULL,
	"default_locale" text,
	"time_zone" text,
	"currency" text,
	"join_policy" text,
	"organization_number" text,
	"decided_by_person_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_message" text,
	"created_club_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_creation_requests_status" CHECK ("club_creation_requests"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "club_creation_requests_join_policy" CHECK ("club_creation_requests"."join_policy" IS NULL OR "club_creation_requests"."join_policy" IN ('open', 'approval', 'invite_only')),
	CONSTRAINT "club_creation_requests_club" CHECK (("club_creation_requests"."status" = 'approved') = ("club_creation_requests"."created_club_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "club_manager_reassignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"operator_person_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "join_requests" ADD COLUMN "decision_message" text;--> statement-breakpoint
ALTER TABLE "club_creation_requests" ADD CONSTRAINT "club_creation_requests_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_creation_requests" ADD CONSTRAINT "club_creation_requests_decided_by_person_id_people_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_manager_reassignments" ADD CONSTRAINT "club_manager_reassignments_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_manager_reassignments" ADD CONSTRAINT "club_manager_reassignments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_manager_reassignments" ADD CONSTRAINT "club_manager_reassignments_operator_person_id_people_id_fk" FOREIGN KEY ("operator_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_acceptances" ADD CONSTRAINT "invitation_acceptances_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_acceptances" ADD CONSTRAINT "invitation_acceptances_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_acceptances" ADD CONSTRAINT "invitation_acceptances_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_creation_requests_pending_unique" ON "club_creation_requests" USING btree ("requested_by_person_id") WHERE "club_creation_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "club_creation_requests_status_idx" ON "club_creation_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "club_manager_reassignments_club_idx" ON "club_manager_reassignments" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_acceptances_unique" ON "invitation_acceptances" USING btree ("invitation_id","person_id");--> statement-breakpoint
CREATE INDEX "invitation_acceptances_person_idx" ON "invitation_acceptances" USING btree ("person_id");--> statement-breakpoint
-------------------------------------------------------------------------------
-- Hand-written part (P1.1): access paths for sign-up and joining (ADR 0018,
-- ADR 0023), club search, and join requests as the only record of an
-- application.
-------------------------------------------------------------------------------

-- Club-owned: tenant isolation, updated_at, history; people see their own.
SELECT app.enable_tenant_rls('public.invitation_acceptances'),
  app.enable_updated_at('public.invitation_acceptances'),
  history.enable_history('public.invitation_acceptances');
CREATE POLICY own_relationships ON public.invitation_acceptances FOR SELECT
  USING (person_id = app.current_person_id());
SELECT app.enable_tenant_rls('public.club_manager_reassignments'),
  app.enable_updated_at('public.club_manager_reassignments'),
  history.enable_history('public.club_manager_reassignments');
REVOKE DELETE ON public.club_manager_reassignments FROM clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- Global: the requester and platform operators (who decide).
ALTER TABLE public.club_creation_requests
  ADD CONSTRAINT club_creation_requests_created_club_fk FOREIGN KEY (created_club_id) REFERENCES public.clubs (id);
CREATE INDEX club_creation_requests_requester_idx ON public.club_creation_requests (requested_by_person_id, created_at);
ALTER TABLE public.club_creation_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY requester_access ON public.club_creation_requests
  USING (app.is_system() OR requested_by_person_id = app.current_person_id() OR app.is_platform_operator())
  WITH CHECK (app.is_system() OR requested_by_person_id = app.current_person_id() OR app.is_platform_operator());
CREATE POLICY retention_access ON public.club_creation_requests TO clubadmin_retention USING (true) WITH CHECK (true);
SELECT app.enable_updated_at('public.club_creation_requests'),
  history.enable_history('public.club_creation_requests');
REVOKE DELETE ON public.club_creation_requests FROM clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- Applicants see the clubs they (or their wards) asked to join, for "my
-- requests"; the request rows themselves are readable through
-- own_relationships (0001).
CREATE POLICY applicant_read ON public.clubs FOR SELECT
  USING (id IN (
    SELECT jr.club_id FROM public.join_requests jr
    WHERE jr.status = 'pending' AND (
      jr.person_id = ANY ((SELECT app.self_and_wards())::uuid[])
      OR jr.requested_by_person_id = app.current_person_id()
    )
  ));
-- "My join requests" (requests made for one's children too, any status).
CREATE INDEX join_requests_requester_idx ON public.join_requests (requested_by_person_id);
--> statement-breakpoint

-- Club search (logged-in people looking for a club to join) and invitation
-- lookup (from a link or code, before the person is in the club) read across
-- clubs. clubs and invitations are forced under RLS, also for their owner, so
-- these functions open a narrow read path while they run: app.lookup is set
-- for the duration of the query and cleared before returning, and the
-- lookup_read policies only apply while it is set (like app.club_id, it is
-- set by trusted code only).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX clubs_name_trgm_idx ON public.clubs USING gin (lower(name) public.gin_trgm_ops);
CREATE INDEX clubs_listed_name_idx ON public.clubs (lower(name), id)
  WHERE status = 'active' AND join_policy <> 'invite_only' AND access_state <> 'suspended';
CREATE POLICY lookup_read ON public.clubs FOR SELECT
  USING (app.setting('app.lookup') IN ('club_search', 'invitation'));
CREATE POLICY lookup_read ON public.invitations FOR SELECT
  USING (app.setting('app.lookup') = 'invitation');
--> statement-breakpoint

-- Listed clubs only (active, not suspended, not invite_only) and only the
-- fields a public listing needs. Keyset on (lower(name), id) after the
-- cursor's club; matching uses the trigram index.
CREATE FUNCTION app.search_clubs(p_query text, p_country text, p_after_id uuid, p_limit integer)
  RETURNS TABLE (id uuid, name text, short_name text, city text, country text, join_policy text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF app.current_person_id() IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.lookup', 'club_search', true);
  RETURN QUERY
  SELECT c.id, c.name, c.short_name, c.address ->> 'city', c.country, c.join_policy
  FROM public.clubs c
  WHERE c.status = 'active' AND c.join_policy <> 'invite_only' AND c.access_state <> 'suspended'
    AND (p_query IS NULL OR lower(c.name) LIKE '%' || lower(p_query) || '%'
         OR lower(coalesce(c.short_name, '')) = lower(p_query)
         OR lower(coalesce(c.address ->> 'city', '')) = lower(p_query))
    AND (p_country IS NULL OR c.country = p_country)
    AND (p_after_id IS NULL OR (lower(c.name), c.id) > (
      SELECT lower(a.name), a.id FROM public.clubs a WHERE a.id = p_after_id))
  ORDER BY lower(c.name), c.id
  LIMIT least(greatest(p_limit, 1), 51);
  PERFORM set_config('app.lookup', '', true);
END
$$;
--> statement-breakpoint

-- The joining flow holds only the token or code: it learns which club the
-- invitation is for before acting in that club. Expired, revoked and used-up
-- invitations are not found.
CREATE FUNCTION app.find_club_invitation(p_token_hash text)
  RETURNS TABLE (invitation_id uuid, club_id uuid, club_name text, kind text, email text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM set_config('app.lookup', 'invitation', true);
  RETURN QUERY
  SELECT i.id, i.club_id, c.name, i.kind, i.email
  FROM public.invitations i
  JOIN public.clubs c ON c.id = i.club_id
  WHERE i.token_hash = p_token_hash AND i.revoked_at IS NULL AND i.expires_at > now()
    AND (i.max_uses IS NULL OR i.uses < i.max_uses) AND c.status = 'active';
  PERFORM set_config('app.lookup', '', true);
END
$$;
--> statement-breakpoint

-- Join requests replace applied memberships (ADR 0018, P1.1): every open
-- applied membership becomes a pending join request (an existing pending
-- request for the same person is kept) and the membership row is removed.
-- The status stays in the enum (ADR 0029); no code writes it any more.
-- Club tables are forced under RLS, also for the migration: work club by
-- club (clubs are readable to the migration, system_read in 0002).
DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    INSERT INTO public.join_requests (club_id, person_id, requested_by_person_id, status, created_at)
    SELECT m.club_id, m.person_id, m.person_id, 'pending', m.created_at
    FROM public.club_memberships m
    WHERE m.club_id = v_club AND m.status = 'applied' AND m.valid_to IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.join_requests jr
        WHERE jr.club_id = m.club_id AND jr.person_id = m.person_id AND jr.status = 'pending'
      );
    DELETE FROM public.club_memberships
    WHERE club_id = v_club AND status = 'applied' AND valid_to IS NULL;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
