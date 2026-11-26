-- P2.7g: the announcement composer's reach (app.entries_people) found the
-- audience's guardians with a scan of every guardianship (the planner's
-- choice for a hash join): now one lookup per person by the ward index
-- (guardianships_ward_idx), so the preview's cost follows the audience, not
-- the database (docs/performance.md, request budgets). Same result.

CREATE OR REPLACE FUNCTION app.entries_people(p_club uuid, p_entries jsonb) RETURNS TABLE (person_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH e AS MATERIALIZED (
    SELECT x.kind, p_club AS club_id, x."groupId" AS group_id,
      coalesce(x."roleIds", '{}') AS role_ids, x."roleId" AS role_id
    FROM jsonb_to_recordset(p_entries) AS x(kind text, "groupId" uuid, "roleIds" uuid[], "roleId" uuid)),
  direct AS (
    SELECT m.person_id FROM e JOIN public.club_memberships m ON m.club_id = e.club_id
    WHERE e.kind = 'club' AND m.valid_to IS NULL AND m.status IN ('active', 'paused')
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm ON gm.club_id = e.club_id
    WHERE e.kind = 'club' AND gm.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm
      ON gm.group_id = e.group_id AND gm.club_id = e.club_id
    WHERE e.kind = 'group' AND gm.valid_to IS NULL
    UNION
    SELECT gm.person_id FROM e JOIN public.group_memberships gm
      ON gm.group_id = e.group_id AND gm.club_id = e.club_id
    WHERE e.kind = 'group_roles' AND gm.valid_to IS NULL AND gm.role_id = ANY (e.role_ids)),
  roles AS (
    SELECT r.person_id FROM e JOIN public.club_role_assignments r
      ON r.club_id = e.club_id AND (e.kind = 'club' OR (e.kind = 'club_role' AND r.role_id = e.role_id))
    WHERE e.kind IN ('club', 'club_role') AND r.valid_to IS NULL)
  SELECT person_id FROM direct
  UNION
  SELECT g.guardian_person_id FROM direct CROSS JOIN LATERAL (
    SELECT g.guardian_person_id FROM public.guardianships g
    WHERE g.ward_person_id = direct.person_id AND g.valid_to IS NULL
      AND g.status = 'active' AND 'receive_messages' = ANY (g.rights)
    OFFSET 0) g
  UNION
  SELECT person_id FROM roles
$$;
