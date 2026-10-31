CREATE TABLE "club_phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"label" text NOT NULL,
	"number" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_phone_numbers_label" CHECK (length("club_phone_numbers"."label") BETWEEN 1 AND 60),
	CONSTRAINT "club_phone_numbers_number" CHECK (length("club_phone_numbers"."number") BETWEEN 3 AND 40)
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "kind_label" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "created_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "kind_label" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "club_phone_numbers" ADD CONSTRAINT "club_phone_numbers_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_phone_numbers_club_idx" ON "club_phone_numbers" USING btree ("club_id","sort_order");--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "locations_creator_idx" ON "locations" USING btree ("created_by_person_id");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_kind_label" CHECK ("activities"."kind_label" IS NULL OR ("activities"."kind" = 'other' AND length("activities"."kind_label") BETWEEN 1 AND 60));--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_email" CHECK ("clubs"."email" IS NULL OR (length("clubs"."email") <= 254 AND "clubs"."email" ~ '^[^@\s]+@[^@\s]+$'));--> statement-breakpoint

-- Hand-written (P1.6b). The club's phone numbers are club-owned: tenant RLS,
-- updated_at and record history like every table.
SELECT app.enable_tenant_rls('public.club_phone_numbers'),
  app.enable_updated_at('public.club_phone_numbers'),
  history.enable_history('public.club_phone_numbers');
--> statement-breakpoint

-- Members read the club's numbers (club pages), as they read the club.
CREATE POLICY insider_read ON public.club_phone_numbers FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
--> statement-breakpoint

-- Lists read naturally with the given name first (P1.6b): sort_given_name
-- next to sort_name (kept for the register's "family name" order). Views
-- only grow at the end of their column list.
CREATE OR REPLACE VIEW app.visible_group_members WITH (security_invoker = true, security_barrier = true) AS
SELECT gm.id, gm.club_id, gm.group_id, gm.person_id, gm.function, gm.valid_from,
       lower(p.family_name) || ' ' || lower(p.given_name) AS sort_name,
       lower(p.given_name) || ' ' || lower(p.family_name) AS sort_given_name
FROM public.group_memberships gm
JOIN public.people p ON p.id = gm.person_id
LEFT JOIN public.club_profiles cp ON cp.club_id = gm.club_id AND cp.person_id = gm.person_id
WHERE gm.valid_to IS NULL AND (
  app.viewer_privileged()
  OR NOT (p.protected_identity OR coalesce(cp.protected_identity_club, false))
  OR gm.person_id = ANY ((SELECT app.self_and_wards())::uuid[])
);
--> statement-breakpoint

CREATE OR REPLACE VIEW app.register_entries AS
SELECT m.club_id, m.person_id, m.id AS membership_id, m.status, m.membership_type,
       m.valid_from, m.valid_to, cp.member_number, cp.shared_fields, p.birth_date, p.gender,
       lower(p.family_name) || ' ' || lower(p.given_name) AS sort_name,
       lower(p.given_name || ' ' || p.family_name) AS search_name,
       coalesce(p.protected_identity OR cp.protected_identity_club, true) AS is_protected,
       (app.viewer_privileged()
         OR NOT coalesce(p.protected_identity OR cp.protected_identity_club, true)
         OR m.person_id = ANY ((SELECT app.self_and_wards())::uuid[])) AS visible,
       lower(p.given_name) || ' ' || lower(p.family_name) AS sort_given_name
FROM public.club_memberships m
LEFT JOIN public.club_profiles cp ON cp.club_id = m.club_id AND cp.person_id = m.person_id
LEFT JOIN public.people p ON p.id = m.person_id
WHERE m.status <> 'applied'
  AND (m.valid_to IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.club_memberships later
    WHERE later.club_id = m.club_id AND later.person_id = m.person_id
      AND later.status <> 'applied' AND later.id <> m.id
      AND (later.valid_to IS NULL OR (later.valid_from, later.id) > (m.valid_from, m.id))
  ));
--> statement-breakpoint

-- A group created by mistake can be deleted while nothing refers to it
-- (P1.6b): the foreign keys to groups (none cascades) refuse the delete
-- otherwise, and the history trigger keeps the deleted row. The operator
-- still never deletes groups.
GRANT DELETE ON public.groups TO clubadmin_app;
