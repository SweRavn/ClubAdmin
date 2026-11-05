-- SPDX-License-Identifier: AGPL-3.0-only
-- P1.9: reading the record history and the audit log (ADR 0042).
--
-- History is read rarely, by club managers and registrars only; reading it
-- must not burden the everyday paths. So the history table gets one index
-- change only (a keyset tie-breaker on the club index, same number of
-- indexes, so the history trigger's write cost does not grow); the
-- filtered club-wide view is bounded by a date range instead of extra
-- indexes. The audit log is small (one event per action), so it gets the
-- indexes its filters need.

-- The club index with the keyset tie-breaker (newest first, then id). On a
-- partitioned table CREATE INDEX builds the index on every partition (new
-- partitions inherit it). It runs in the migration's transaction: only the
-- current month's partition takes writes, so the short write block while
-- its index builds is accepted (ADR 0042, measured on the history volume).
CREATE INDEX record_changes_club_keyset_idx
  ON history.record_changes (club_id, changed_at DESC, id DESC);
--> statement-breakpoint
-- Replaced by the index above (same leading columns; nothing else uses it).
DROP INDEX history.record_changes_club_idx;
--> statement-breakpoint

-- Audit log filters (P1.9): by actor and by action within a club, and the
-- resource index with the keyset tie-breaker.
CREATE INDEX events_club_actor_idx
  ON audit.events (club_id, actor_person_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX events_club_action_idx
  ON audit.events (club_id, action, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX events_resource_keyset_idx
  ON audit.events (resource_type, resource_id, created_at DESC, id DESC);
--> statement-breakpoint
DROP INDEX audit.events_resource_idx;
--> statement-breakpoint

-- History of global rows (club_id IS NULL), which the app role cannot read
-- (club_read covers the current club only): people and guardianships only,
-- for record IDs the caller may see in the current club context
-- (app.can_see_person; for a guardianship both parties). Never accounts or
-- other global tables. Authorization in the API is primary (club managers
-- and registrars); this is the database backstop. Newest first, keyset on
-- (changed_at, id), at most 201 rows (a page and one to know there is more).
CREATE FUNCTION history.read_global_changes(
  p_tables text[],
  p_record_ids uuid[],
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
) RETURNS SETOF history.record_changes
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  -- The caller's check runs once per record (not per history row), then one
  -- index range per record and partition (record_changes_record_idx).
  WITH allowed AS MATERIALIZED (
    SELECT DISTINCT s.table_name, s.record_id
    FROM unnest(p_tables, p_record_ids) AS s(table_name, record_id)
    WHERE s.table_name IN ('public.people', 'public.guardianships')
      AND CASE s.table_name
        WHEN 'public.people' THEN app.can_see_person(s.record_id, NULL)
        ELSE EXISTS (
          SELECT 1 FROM public.guardianships g
          WHERE g.id = s.record_id
            AND app.can_see_person(g.guardian_person_id, NULL)
            AND app.can_see_person(g.ward_person_id, NULL)
        )
      END
  )
  SELECT h.*
  FROM allowed a
  CROSS JOIN LATERAL (
    SELECT c.* FROM history.record_changes c
    WHERE c.table_name = a.table_name AND c.record_id = a.record_id AND c.club_id IS NULL
      AND (p_before_at IS NULL OR (c.changed_at, c.id) < (p_before_at, p_before_id))
    ORDER BY c.changed_at DESC, c.id DESC
    LIMIT least(greatest(p_limit, 1), 201)
  ) AS h
  ORDER BY h.changed_at DESC, h.id DESC
  LIMIT least(greatest(p_limit, 1), 201)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION history.read_global_changes(text[], uuid[], timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION history.read_global_changes(text[], uuid[], timestamptz, uuid, integer) TO clubadmin_app;
