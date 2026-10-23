CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"series_id" uuid,
	"occurrence_on" date,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"cancelled_reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"meet_at" timestamp with time zone,
	"meet_place" text,
	"location_id" uuid,
	"location_text" text,
	"notes" text,
	"leader_notes" text,
	"opponent" text,
	"home_away" text,
	"competition" text,
	"detached" boolean DEFAULT false NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_club_id_unique" UNIQUE("club_id","id"),
	CONSTRAINT "activities_kind" CHECK ("activities"."kind" IN ('training', 'match', 'meeting', 'other')),
	CONSTRAINT "activities_status" CHECK ("activities"."status" IN ('scheduled', 'cancelled')),
	CONSTRAINT "activities_home_away" CHECK ("activities"."home_away" IS NULL OR "activities"."home_away" IN ('home', 'away', 'neutral')),
	CONSTRAINT "activities_period" CHECK ("activities"."ends_at" > "activities"."starts_at"),
	CONSTRAINT "activities_cancelled_reason" CHECK ("activities"."cancelled_reason" IS NULL OR "activities"."status" = 'cancelled')
);
--> statement-breakpoint
CREATE TABLE "activity_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_groups_unique" UNIQUE("activity_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "activity_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"leader_notes" text,
	"location_id" uuid,
	"location_text" text,
	"slots" jsonb NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"skip_dates" date[] DEFAULT '{}'::date[] NOT NULL,
	"skip_public_holidays" boolean DEFAULT false NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_series_club_id_unique" UNIQUE("club_id","id"),
	CONSTRAINT "activity_series_kind" CHECK ("activity_series"."kind" IN ('training', 'match', 'meeting', 'other')),
	CONSTRAINT "activity_series_period" CHECK ("activity_series"."ends_on" >= "activity_series"."starts_on"),
	CONSTRAINT "activity_series_length" CHECK ("activity_series"."ends_on" - "activity_series"."starts_on" <= 400)
);
--> statement-breakpoint
CREATE TABLE "activity_series_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_series_groups_unique" UNIQUE("series_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"street" text,
	"postal_code" text,
	"city" text,
	"latitude" double precision,
	"longitude" double precision,
	"directions" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_club_id_unique" UNIQUE("club_id","id"),
	CONSTRAINT "locations_coordinates" CHECK (("locations"."latitude" IS NULL) = ("locations"."longitude" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "schedule_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"cancelled_reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean NOT NULL,
	"meet_at" timestamp with time zone,
	"place" text,
	"changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_entries_unique" UNIQUE("activity_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_series_fk" FOREIGN KEY ("club_id","series_id") REFERENCES "public"."activity_series"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_groups" ADD CONSTRAINT "activity_groups_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_groups" ADD CONSTRAINT "activity_groups_activity_fk" FOREIGN KEY ("club_id","activity_id") REFERENCES "public"."activities"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_groups" ADD CONSTRAINT "activity_groups_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_series" ADD CONSTRAINT "activity_series_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_series" ADD CONSTRAINT "activity_series_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_series" ADD CONSTRAINT "activity_series_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_series_groups" ADD CONSTRAINT "activity_series_groups_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_series_groups" ADD CONSTRAINT "activity_series_groups_series_fk" FOREIGN KEY ("club_id","series_id") REFERENCES "public"."activity_series"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_series_groups" ADD CONSTRAINT "activity_series_groups_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD CONSTRAINT "schedule_entries_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD CONSTRAINT "schedule_entries_activity_fk" FOREIGN KEY ("club_id","activity_id") REFERENCES "public"."activities"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_series_occurrence_unique" ON "activities" USING btree ("series_id","occurrence_on") WHERE "activities"."series_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "activities_club_starts_idx" ON "activities" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE INDEX "activities_location_idx" ON "activities" USING btree ("club_id","location_id","starts_at") WHERE "activities"."location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "activities_creator_idx" ON "activities" USING btree ("created_by_person_id");--> statement-breakpoint
CREATE INDEX "activity_groups_group_idx" ON "activity_groups" USING btree ("club_id","group_id");--> statement-breakpoint
CREATE INDEX "activity_series_club_idx" ON "activity_series" USING btree ("club_id","starts_on");--> statement-breakpoint
CREATE INDEX "activity_series_creator_idx" ON "activity_series" USING btree ("created_by_person_id");--> statement-breakpoint
CREATE INDEX "activity_series_groups_group_idx" ON "activity_series_groups" USING btree ("club_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_name_unique" ON "locations" USING btree ("club_id",lower("name")) WHERE "locations"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "schedule_entries_group_idx" ON "schedule_entries" USING btree ("group_id","starts_at");--> statement-breakpoint
CREATE INDEX "schedule_entries_club_idx" ON "schedule_entries" USING btree ("club_id","starts_at");--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (P1.4, ADR 0034): activities and the calendars.
-------------------------------------------------------------------------------

SELECT app.enable_tenant_rls('public.locations'),
  app.enable_updated_at('public.locations'),
  history.enable_history('public.locations');
-- Locations are archived, never deleted (activities keep pointing at them).
REVOKE DELETE ON public.locations FROM clubadmin_app, clubadmin_operator;
SELECT app.enable_tenant_rls('public.activity_series'),
  app.enable_updated_at('public.activity_series'),
  history.enable_history('public.activity_series');
SELECT app.enable_tenant_rls('public.activity_series_groups'),
  app.enable_updated_at('public.activity_series_groups'),
  history.enable_history('public.activity_series_groups');
SELECT app.enable_tenant_rls('public.activities'),
  app.enable_updated_at('public.activities'),
  history.enable_history('public.activities');
SELECT app.enable_tenant_rls('public.activity_groups'),
  app.enable_updated_at('public.activity_groups'),
  history.enable_history('public.activity_groups');
-- The read model: derived from activities (no record history of its own,
-- history-exclusions.ts).
SELECT app.enable_tenant_rls('public.schedule_entries'),
  app.enable_updated_at('public.schedule_entries');
--> statement-breakpoint

-- "My schedule" reads across clubs: an entry is readable by the members of
-- its group and their guardians (the same path as the groups' member_read
-- policy). The service narrows linked guardians to those with view_schedule.
CREATE POLICY member_read ON public.schedule_entries FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.group_memberships gm
    WHERE gm.group_id = schedule_entries.group_id AND gm.valid_to IS NULL
      AND gm.person_id = ANY ((SELECT app.self_and_wards())::uuid[])
  ));
--> statement-breakpoint

-- Outside a club context (the authorization module resolving an
-- /activities/:id or /activity-series/:id route), people related to the club
-- read an activity's or series' club and groups, as groups' insider_read
-- does. The first condition keeps club transactions (calendars) from
-- evaluating the relationship check for every row.
CREATE POLICY insider_read ON public.activities FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
--> statement-breakpoint
CREATE POLICY insider_read ON public.activity_groups FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
--> statement-breakpoint
CREATE POLICY insider_read ON public.activity_series FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
--> statement-breakpoint
CREATE POLICY insider_read ON public.activity_series_groups FOR SELECT
  USING (app.current_club_id() IS NULL AND app.has_club_relationship(club_id));
--> statement-breakpoint

-- The club and groups of an activity or series, for the authorization
-- module's resource loader (IDs only; the policy decides, and 404 hides the
-- rest). Runs as the caller: rows of clubs they are not related to are not there.
CREATE FUNCTION app.activity_scope(p_activity uuid, p_series uuid)
  RETURNS TABLE (club_id uuid, group_ids uuid[])
  LANGUAGE sql STABLE
  AS $$
  SELECT a.club_id, array_agg(ag.group_id ORDER BY ag.group_id)
  FROM public.activities a JOIN public.activity_groups ag ON ag.activity_id = a.id
  WHERE p_activity IS NOT NULL AND a.id = p_activity
  GROUP BY a.club_id
  UNION ALL
  SELECT s.club_id, array_agg(sg.group_id ORDER BY sg.group_id)
  FROM public.activity_series s JOIN public.activity_series_groups sg ON sg.series_id = s.id
  WHERE p_series IS NOT NULL AND s.id = p_series
  GROUP BY s.club_id
$$;
