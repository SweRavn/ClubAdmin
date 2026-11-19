-- P2.7c: a place nobody uses can be deleted. Counting its uses starts from
-- the club and the place in every table that refers to one (activities have
-- activities_location_idx already).

CREATE INDEX IF NOT EXISTS activity_series_location_idx ON public.activity_series (club_id, location_id)
  WHERE location_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_location_idx ON public.events (club_id, location_id)
  WHERE location_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tasks_location_idx ON public.tasks (club_id, location_id)
  WHERE location_id IS NOT NULL;
--> statement-breakpoint

-- A place nobody uses can be deleted (as groups since P1.6b): the foreign
-- keys to locations refuse the delete otherwise (duty shifts lose the place),
-- and the history trigger keeps the deleted row. The operator never deletes.
GRANT DELETE ON public.locations TO clubadmin_app;
