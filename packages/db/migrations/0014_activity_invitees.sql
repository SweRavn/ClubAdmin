CREATE TABLE "activity_invitees" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"invited_by_person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_invitees_unique" UNIQUE("activity_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "invitees_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD COLUMN "invitees_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_invitees" ADD CONSTRAINT "activity_invitees_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_invitees" ADD CONSTRAINT "activity_invitees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_invitees" ADD CONSTRAINT "activity_invitees_invited_by_person_id_people_id_fk" FOREIGN KEY ("invited_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_invitees" ADD CONSTRAINT "activity_invitees_activity_fk" FOREIGN KEY ("club_id","activity_id") REFERENCES "public"."activities"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_invitees_activity_idx" ON "activity_invitees" USING btree ("club_id","activity_id");--> statement-breakpoint
CREATE INDEX "activity_invitees_person_idx" ON "activity_invitees" USING btree ("person_id","activity_id");--> statement-breakpoint
CREATE INDEX "activity_invitees_inviter_idx" ON "activity_invitees" USING btree ("invited_by_person_id");--> statement-breakpoint

-------------------------------------------------------------------------------
-- Hand-written part (#19, ADR 0036): call-ups.
-------------------------------------------------------------------------------

SELECT app.enable_tenant_rls('public.activity_invitees'),
  app.enable_updated_at('public.activity_invitees'),
  history.enable_history('public.activity_invitees');
--> statement-breakpoint

-- "My schedule" reads whether I and my wards are called up, across clubs
-- (the same path as activity_responses' own_read).
CREATE POLICY own_read ON public.activity_invitees FOR SELECT
  USING (person_id = ANY ((SELECT app.self_and_wards())::uuid[]));
--> statement-breakpoint

-- Retention (#18) also removes who was called up to activities past the
-- club's period.
CREATE OR REPLACE FUNCTION app.purge_expired_attendance(OUT responses bigint, OUT attendance bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_club uuid := app.current_club_id();
  v_cutoff timestamptz;
BEGIN
  IF v_club IS NULL OR current_setting('app.actor_kind', true) IS DISTINCT FROM 'system_job' THEN
    RAISE EXCEPTION 'purge_expired_attendance runs as a system job in a club'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT now() - make_interval(months => c.attendance_retention_months) INTO v_cutoff
  FROM public.clubs c WHERE c.id = v_club;

  -- starts_at first (activities_club_starts_idx); an activity ends after it starts.
  DELETE FROM public.activity_responses r
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND r.club_id = v_club AND r.activity_id = a.id;
  GET DIAGNOSTICS responses = ROW_COUNT;

  DELETE FROM public.attendance_records r
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND r.club_id = v_club AND r.activity_id = a.id;
  GET DIAGNOSTICS attendance = ROW_COUNT;

  DELETE FROM public.activity_invitees i
  USING public.activities a
  WHERE a.club_id = v_club AND a.starts_at < v_cutoff AND a.ends_at < v_cutoff
    AND i.club_id = v_club AND i.activity_id = a.id;
END
$$;
