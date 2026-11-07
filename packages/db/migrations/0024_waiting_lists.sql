-- SPDX-License-Identifier: AGPL-3.0-only
-- P1.10b, waiting lists (ADR 0043): offers (when, by whom; null for the
-- worker's auto-offers), the join request created with a non-member's
-- application, a reason for priority, auto-offers per group, a reason when an
-- owner adds a member past people waiting. Accepted entries hold their place
-- (the open-entry index covers them). Expand-only; existing rows are filled
-- in club by club before the new checks (the tables are forced under RLS).
ALTER TABLE "group_waitlist_entries" DROP CONSTRAINT "group_waitlist_entries_closed_reason";--> statement-breakpoint
DROP INDEX "group_waitlist_entries_open_unique";--> statement-breakpoint
ALTER TABLE "group_memberships" ADD COLUMN "queue_bypass_reason" text;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "waitlist_auto_offer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD COLUMN "offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD COLUMN "offered_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD COLUMN "join_request_id" uuid;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD COLUMN "priority_reason" text;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_offered_by_person_id_people_id_fk" FOREIGN KEY ("offered_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_join_request_id_join_requests_id_fk" FOREIGN KEY ("join_request_id") REFERENCES "public"."join_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_memberships_queue_bypass_idx" ON "group_memberships" USING btree ("club_id","created_at") WHERE "group_memberships"."queue_bypass_reason" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "group_waitlist_entries_offers_idx" ON "group_waitlist_entries" USING btree ("club_id","status","offer_expires_at") WHERE "group_waitlist_entries"."status" = 'offered';--> statement-breakpoint
CREATE INDEX "group_waitlist_entries_out_of_order_idx" ON "group_waitlist_entries" USING btree ("club_id","decided_at") WHERE "group_waitlist_entries"."out_of_order_reason" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "group_waitlist_entries_open_unique" ON "group_waitlist_entries" USING btree ("group_id","person_id") WHERE "group_waitlist_entries"."status" IN ('waiting', 'offered', 'accepted');--> statement-breakpoint
DO $$
DECLARE
  v_club uuid;
BEGIN
  FOR v_club IN SELECT id FROM public.clubs LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    UPDATE public.group_waitlist_entries SET priority_reason = 'other'
    WHERE club_id = v_club AND priority > 0 AND priority_reason IS NULL;
    UPDATE public.group_waitlist_entries SET offered_at = coalesce(decided_at, updated_at)
    WHERE club_id = v_club AND status = 'offered' AND offered_at IS NULL;
  END LOOP;
  PERFORM set_config('app.club_id', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_priority_reason" CHECK (("group_waitlist_entries"."priority_reason" IS NULL OR "group_waitlist_entries"."priority_reason" IN ('sibling', 'returning_member', 'other')) AND ("group_waitlist_entries"."priority" = 0 OR "group_waitlist_entries"."priority_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_offered_at" CHECK (("group_waitlist_entries"."status" = 'offered') <= ("group_waitlist_entries"."offered_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_closed_reason_status" CHECK ("group_waitlist_entries"."closed_reason" IS NULL OR "group_waitlist_entries"."status" NOT IN ('waiting', 'offered', 'accepted', 'admitted'));--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_closed_reason" CHECK ("group_waitlist_entries"."closed_reason" IS NULL OR "group_waitlist_entries"."closed_reason" IN ('declined', 'expired', 'withdrawn', 'removed_by_owner', 'join_request_rejected', 'left_club', 'group_archived', 'no_longer_eligible', 'duplicate', 'no_reply'));
--> statement-breakpoint

-- Places of a group today (P1.10b, ADR 0043): the capacity of the season
-- covering today in the club's time zone, else the group's own (null:
-- unlimited); occupied = open `member` functions, outstanding offers and
-- accepted entries (leaders never count). SECURITY INVOKER: callers read
-- through their own policies (a tenant transaction, or the open-groups lookup).
CREATE FUNCTION app.group_places(p_group_id uuid)
  RETURNS TABLE (capacity integer, occupied integer)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT coalesce((
      SELECT gs.capacity FROM public.group_seasons gs
      JOIN public.seasons s ON s.id = gs.season_id
      WHERE gs.group_id = g.id
        AND s.starts_on <= (now() AT TIME ZONE c.time_zone)::date
        AND s.ends_on >= (now() AT TIME ZONE c.time_zone)::date
      ORDER BY s.starts_on DESC LIMIT 1), g.capacity),
    (SELECT count(*)::int FROM public.group_memberships gm
      WHERE gm.club_id = g.club_id AND gm.group_id = g.id AND gm.valid_to IS NULL
        AND gm.function = 'member')
    + (SELECT count(*)::int FROM public.group_waitlist_entries w
      WHERE w.group_id = g.id AND w.status IN ('offered', 'accepted'))
  FROM public.groups g JOIN public.clubs c ON c.id = g.club_id
  WHERE g.id = p_group_id
$$;
GRANT EXECUTE ON FUNCTION app.group_places(uuid) TO clubadmin_app;
--> statement-breakpoint

-- Cross-club reads for applicants (ADR 0032 pattern): the functions below set
-- app.lookup for their one query; these policies apply only then.
ALTER POLICY lookup_read ON public.clubs
  USING (app.setting('app.lookup') IN ('club_search', 'invitation', 'waitlist_position', 'open_groups'));
CREATE POLICY lookup_read ON public.groups FOR SELECT
  USING (app.setting('app.lookup') IN ('waitlist_position', 'open_groups'));
CREATE POLICY lookup_read ON public.group_waitlist_entries FOR SELECT
  USING (app.setting('app.lookup') IN ('waitlist_position', 'open_groups'));
CREATE POLICY lookup_read ON public.group_memberships FOR SELECT
  USING (app.setting('app.lookup') = 'open_groups');
CREATE POLICY lookup_read ON public.group_seasons FOR SELECT
  USING (app.setting('app.lookup') = 'open_groups');
CREATE POLICY lookup_read ON public.seasons FOR SELECT
  USING (app.setting('app.lookup') = 'open_groups');
--> statement-breakpoint

-- An applicant's place in the queue: rank among the group's `waiting`
-- entries by (priority DESC, queued_at, id), and the number waiting; null
-- position while the entry is not waiting. Only entries the caller may read
-- (their own, their wards', those they applied for); the group's and club's
-- names for "my waiting lists". Served by group_waitlist_entries_order_idx.
CREATE FUNCTION app.waitlist_positions(p_entry_ids uuid[])
  RETURNS TABLE (entry_id uuid, "position" integer, waiting_count integer,
                 group_name text, club_name text, club_time_zone text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF app.current_person_id() IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.lookup', 'waitlist_position', true);
  RETURN QUERY
  SELECT e.id,
    CASE WHEN e.status = 'waiting' THEN (
      SELECT count(*)::int + 1 FROM public.group_waitlist_entries o
      WHERE o.group_id = e.group_id AND o.status = 'waiting'
        AND (o.priority > e.priority
          OR (o.priority = e.priority AND (o.queued_at, o.id) < (e.queued_at, e.id)))
    ) END,
    (SELECT count(*)::int FROM public.group_waitlist_entries w
     WHERE w.group_id = e.group_id AND w.status = 'waiting'),
    g.name, c.name, c.time_zone
  FROM public.group_waitlist_entries e
  JOIN public.groups g ON g.club_id = e.club_id AND g.id = e.group_id
  JOIN public.clubs c ON c.id = e.club_id
  WHERE e.id = ANY (p_entry_ids)
    AND (app.is_self_or_ward(e.person_id) OR e.requested_by_person_id = app.current_person_id());
  PERFORM set_config('app.lookup', '', true);
END
$$;
GRANT EXECUTE ON FUNCTION app.waitlist_positions(uuid[]) TO clubadmin_app;
--> statement-breakpoint

-- Groups that take applications from people outside the club (P1.10b): in a
-- club the club search lists (active, not suspended, not invite_only), the
-- unarchived groups with admission_mode = waitlist that are publicly
-- visible, with whether they are full and how many wait. No people.
CREATE FUNCTION app.club_open_groups(p_club_id uuid)
  RETURNS TABLE (id uuid, name text, kind text, parent_name text, sport text,
                 birth_year_from smallint, birth_year_to smallint, gender_category text,
                 level text, full_now boolean, waiting_count integer)
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF app.current_person_id() IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.lookup', 'open_groups', true);
  RETURN QUERY
  SELECT g.id, g.name, g.kind, p.name, g.sport, g.birth_year_from, g.birth_year_to,
    g.gender_category, g.level,
    coalesce(pl.capacity IS NOT NULL AND pl.occupied >= pl.capacity, false),
    (SELECT count(*)::int FROM public.group_waitlist_entries w
     WHERE w.group_id = g.id AND w.status = 'waiting')
  FROM public.clubs c
  JOIN public.groups g ON g.club_id = c.id
  LEFT JOIN public.groups p ON p.club_id = g.club_id AND p.id = g.parent_group_id
  LEFT JOIN LATERAL app.group_places(g.id) pl ON true
  WHERE c.id = p_club_id AND c.status = 'active' AND c.join_policy <> 'invite_only'
    AND c.access_state <> 'suspended'
    AND g.archived_at IS NULL AND g.admission_mode = 'waitlist' AND g.waitlist_visible_publicly
  ORDER BY g.name, g.id
  LIMIT 200;
  PERFORM set_config('app.lookup', '', true);
END
$$;
GRANT EXECUTE ON FUNCTION app.club_open_groups(uuid) TO clubadmin_app;
--> statement-breakpoint

-- The club of a group someone applies for (POST /groups/{id}/waitlist): a
-- group in a listed club that is publicly open for applications, or any
-- unarchived group of a club where the caller or a ward is a member. Null
-- otherwise, so other groups do not exist for the caller (404).
CREATE FUNCTION app.waitlist_group_club(p_group_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_club uuid;
BEGIN
  IF app.current_person_id() IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.lookup', 'open_groups', true);
  SELECT g.club_id INTO v_club
  FROM public.groups g
  JOIN public.clubs c ON c.id = g.club_id
  WHERE g.id = p_group_id AND g.archived_at IS NULL AND c.status = 'active'
    AND (
      (c.join_policy <> 'invite_only' AND c.access_state <> 'suspended'
        AND g.admission_mode = 'waitlist' AND g.waitlist_visible_publicly)
      OR EXISTS (
        SELECT 1 FROM public.club_memberships m
        WHERE m.club_id = g.club_id AND m.valid_to IS NULL AND app.is_self_or_ward(m.person_id)
      )
    );
  PERFORM set_config('app.lookup', '', true);
  RETURN v_club;
END
$$;
GRANT EXECUTE ON FUNCTION app.waitlist_group_club(uuid) TO clubadmin_app;
