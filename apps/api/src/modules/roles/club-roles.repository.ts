// SPDX-License-Identifier: AGPL-3.0-only
// The club's roles and their permissions (P1.15 A2, ADR 0046). Statements
// start from the club and the role (roles by club, role_permissions by
// role, assignments by club_role_assignments_role_idx /
// group_memberships_role_idx), never from a whole table.

import { sql, type Tx } from "@clubadmin/db";

/** A uuid[] parameter (IDs from our own data). */
const uuidArray = (ids: readonly string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

export interface RoleRow {
  id: string;
  clubId: string;
  scope: "club" | "group";
  templateKey: string | null;
  locked: boolean;
  names: Record<string, string> | null;
  descriptions: Record<string, string> | null;
  sortOrder: number;
  archivedAt: Date | null;
  version: number;
  permissions: string[];
  holderCount: number;
}

const ROLE_COLUMNS = sql`r.id, r.club_id, r.scope, r.template_key, r.locked, r.names, r.descriptions,
  r.sort_order, r.archived_at, r.version,
  coalesce((SELECT array_agg(rp.permission ORDER BY rp.permission) FROM public.role_permissions rp
    WHERE rp.role_id = r.id), '{}') AS permissions`;

type RawRole = {
  id: string;
  club_id: string;
  scope: "club" | "group";
  template_key: string | null;
  locked: boolean;
  names: Record<string, string> | null;
  descriptions: Record<string, string> | null;
  sort_order: number;
  archived_at: Date | null;
  version: number;
  permissions: string[];
  holder_count?: number;
};

const toRole = (r: RawRole): RoleRow => ({
  id: r.id,
  clubId: r.club_id,
  scope: r.scope,
  templateKey: r.template_key,
  locked: r.locked,
  names: r.names,
  descriptions: r.descriptions,
  sortOrder: r.sort_order,
  archivedAt: r.archived_at ? new Date(r.archived_at) : null,
  version: r.version,
  permissions: r.permissions,
  holderCount: r.holder_count ?? 0,
});

/** The club's roles (not deleted) with their permissions, without holder counts. */
export async function rolesOfClub(tx: Tx, clubId: string): Promise<RoleRow[]> {
  const { rows } = await tx.execute<RawRole>(sql`
    SELECT ${ROLE_COLUMNS} FROM public.roles r
    WHERE r.club_id = ${clubId} AND r.archived_at IS NULL
    ORDER BY r.scope, r.sort_order, r.created_at`);
  return rows.map(toRole);
}

/** The club's roles (not deleted) with their permissions and open assignments. */
export async function listRoles(tx: Tx, clubId: string): Promise<RoleRow[]> {
  const { rows } = await tx.execute<RawRole>(sql`
    SELECT ${ROLE_COLUMNS},
      (SELECT count(*)::int FROM public.club_role_assignments a
        WHERE a.club_id = r.club_id AND a.role_id = r.id AND a.valid_to IS NULL)
      + (SELECT count(*)::int FROM public.group_memberships gm
        WHERE gm.club_id = r.club_id AND gm.role_id = r.id AND gm.valid_to IS NULL) AS holder_count
    FROM public.roles r
    WHERE r.club_id = ${clubId} AND r.archived_at IS NULL
    ORDER BY r.scope, r.sort_order, r.created_at`);
  return rows.map(toRole);
}

/** One role of the club, locked for a change when `forUpdate`. */
export async function getRole(
  tx: Tx,
  clubId: string,
  roleId: string,
  forUpdate = false,
): Promise<RoleRow | null> {
  const { rows } = await tx.execute<RawRole>(sql`
    SELECT ${ROLE_COLUMNS} FROM public.roles r
    WHERE r.club_id = ${clubId} AND r.id = ${roleId} AND r.archived_at IS NULL
    ${forUpdate ? sql`FOR UPDATE OF r` : sql``}`);
  return rows[0] ? toRole(rows[0]) : null;
}

/** A template role of the club by its key. */
export async function templateRole(
  tx: Tx,
  clubId: string,
  scope: "club" | "group",
  templateKey: string,
): Promise<RoleRow | null> {
  const { rows } = await tx.execute<RawRole>(sql`
    SELECT ${ROLE_COLUMNS} FROM public.roles r
    WHERE r.club_id = ${clubId} AND r.scope = ${scope} AND r.template_key = ${templateKey}
      AND r.archived_at IS NULL`);
  return rows[0] ? toRole(rows[0]) : null;
}

export async function insertRole(
  tx: Tx,
  values: {
    clubId: string;
    scope: "club" | "group";
    names: Record<string, string>;
    descriptions: Record<string, string> | null;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.roles (club_id, scope, names, descriptions, sort_order)
    VALUES (${values.clubId}, ${values.scope}, ${JSON.stringify(values.names)}::jsonb,
      ${values.descriptions ? JSON.stringify(values.descriptions) : null}::jsonb,
      1000 + (SELECT count(*)::int FROM public.roles WHERE club_id = ${values.clubId}))
    RETURNING id`);
  return rows[0]!.id;
}

export async function updateRoleTexts(
  tx: Tx,
  roleId: string,
  changes: {
    names?: Record<string, string> | null;
    descriptions?: Record<string, string> | null;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.roles SET
      names = CASE WHEN ${"names" in changes} THEN ${changes.names ? JSON.stringify(changes.names) : null}::jsonb ELSE names END,
      descriptions = CASE WHEN ${"descriptions" in changes} THEN ${changes.descriptions ? JSON.stringify(changes.descriptions) : null}::jsonb ELSE descriptions END
    WHERE id = ${roleId}`);
}

export async function bumpVersion(tx: Tx, roleId: string): Promise<void> {
  await tx.execute(sql`UPDATE public.roles SET version = version + 1 WHERE id = ${roleId}`);
}

export async function addPermissions(
  tx: Tx,
  clubId: string,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  if (permissions.length === 0) return;
  await tx.execute(sql`
    INSERT INTO public.role_permissions (club_id, role_id, permission)
    SELECT ${clubId}, ${roleId}, p FROM unnest(${`{${permissions.join(",")}}`}::text[]) p
    ON CONFLICT (role_id, permission) DO NOTHING`);
}

export async function removePermissions(
  tx: Tx,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  if (permissions.length === 0) return;
  await tx.execute(sql`
    DELETE FROM public.role_permissions
    WHERE role_id = ${roleId} AND permission = ANY (${`{${permissions.join(",")}}`}::text[])`);
}

export async function archiveRole(tx: Tx, roleId: string): Promise<void> {
  await tx.execute(sql`UPDATE public.roles SET archived_at = now() WHERE id = ${roleId}`);
}

/** The club's archived roles' template keys, as "scope:key" (P1.15 B). */
export async function archivedTemplateKeys(tx: Tx, clubId: string): Promise<Set<string>> {
  const { rows } = await tx.execute<{ scope: string; template_key: string }>(sql`
    SELECT scope, template_key FROM public.roles
    WHERE club_id = ${clubId} AND template_key IS NOT NULL AND archived_at IS NOT NULL`);
  return new Set(rows.map((r) => `${r.scope}:${r.template_key}`));
}

/** The club's role with a template key, archived or not (roles_template_unique). */
export async function roleByTemplateKey(
  tx: Tx,
  clubId: string,
  scope: string,
  templateKey: string,
): Promise<RoleRow | null> {
  const { rows } = await tx.execute<RawRole>(sql`
    SELECT ${ROLE_COLUMNS} FROM public.roles r
    WHERE r.club_id = ${clubId} AND r.scope = ${scope} AND r.template_key = ${templateKey}
    FOR UPDATE OF r`);
  return rows[0] ? toRole(rows[0]) : null;
}

/** A role copied from the club type's template (P1.15 B). */
export async function insertTemplateRole(
  tx: Tx,
  values: {
    clubId: string;
    scope: "club" | "group";
    templateKey: string;
    locked: boolean;
    names: Record<string, string> | null;
    descriptions: Record<string, string> | null;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.roles (club_id, scope, template_key, locked, names, descriptions, sort_order)
    VALUES (${values.clubId}, ${values.scope}, ${values.templateKey}, ${values.locked},
      ${values.names ? JSON.stringify(values.names) : null}::jsonb,
      ${values.descriptions ? JSON.stringify(values.descriptions) : null}::jsonb,
      1000 + (SELECT count(*)::int FROM public.roles WHERE club_id = ${values.clubId}))
    RETURNING id`);
  return rows[0]!.id;
}

export async function restoreRole(tx: Tx, roleId: string): Promise<void> {
  await tx.execute(sql`UPDATE public.roles SET archived_at = NULL WHERE id = ${roleId}`);
}

/** Open holders of a role: club assignments and group memberships. */
export async function holdersOfRole(
  tx: Tx,
  clubId: string,
  roleId: string,
): Promise<{ assignmentId: string; personId: string; groupId: string | null }[]> {
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    group_id: string | null;
  }>(sql`
    SELECT a.id, a.person_id, NULL::uuid AS group_id FROM public.club_role_assignments a
    WHERE a.club_id = ${clubId} AND a.role_id = ${roleId} AND a.valid_to IS NULL
    UNION ALL
    SELECT gm.id, gm.person_id, gm.group_id FROM public.group_memberships gm
    WHERE gm.club_id = ${clubId} AND gm.role_id = ${roleId} AND gm.valid_to IS NULL`);
  return rows.map((r) => ({ assignmentId: r.id, personId: r.person_id, groupId: r.group_id }));
}

/**
 * Permissions the people hold through their other roles than `exceptRoleId`
 * (club-wide), for the change preview.
 */
export async function otherPermissionsOf(
  tx: Tx,
  clubId: string,
  personIds: readonly string[],
  exceptRoleId: string,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (personIds.length === 0) return result;
  const { rows } = await tx.execute<{ person_id: string; permission: string }>(sql`
    SELECT DISTINCT h.person_id, rp.permission FROM (
      SELECT a.person_id, a.role_id FROM public.club_role_assignments a
      WHERE a.club_id = ${clubId} AND a.person_id = ANY (${uuidArray(personIds)})
        AND a.valid_to IS NULL AND a.role_id <> ${exceptRoleId}
      UNION
      SELECT gm.person_id, gm.role_id FROM public.group_memberships gm
      WHERE gm.club_id = ${clubId} AND gm.person_id = ANY (${uuidArray(personIds)})
        AND gm.valid_to IS NULL AND gm.role_id <> ${exceptRoleId}
    ) h JOIN public.role_permissions rp ON rp.role_id = h.role_id`);
  for (const r of rows) {
    const set = result.get(r.person_id) ?? new Set<string>();
    set.add(r.permission);
    result.set(r.person_id, set);
  }
  return result;
}

/** Who holds a permission in the club, keyset-paginated by person. */
export async function holdersOfPermission(
  tx: Tx,
  clubId: string,
  permission: string,
  page: { cursor: string | null; limit: number },
): Promise<{ personId: string; roleIds: string[]; groupIds: string[] }[]> {
  const { rows } = await tx.execute<{ person_id: string; role_ids: string[]; group_ids: string[] }>(
    sql`
    WITH roles AS (
      SELECT rp.role_id FROM public.role_permissions rp
      WHERE rp.club_id = ${clubId} AND rp.permission = ${permission}
    ), h AS (
      SELECT a.person_id, a.role_id, NULL::uuid AS group_id FROM public.club_role_assignments a
      WHERE a.club_id = ${clubId} AND a.role_id IN (SELECT role_id FROM roles) AND a.valid_to IS NULL
        AND (${page.cursor}::uuid IS NULL OR a.person_id > ${page.cursor}::uuid)
      UNION ALL
      SELECT gm.person_id, gm.role_id, gm.group_id FROM public.group_memberships gm
      WHERE gm.club_id = ${clubId} AND gm.role_id IN (SELECT role_id FROM roles) AND gm.valid_to IS NULL
        AND (${page.cursor}::uuid IS NULL OR gm.person_id > ${page.cursor}::uuid)
    )
    SELECT person_id, array_agg(DISTINCT role_id) AS role_ids,
      coalesce(array_agg(DISTINCT group_id) FILTER (WHERE group_id IS NOT NULL), '{}') AS group_ids
    FROM h GROUP BY person_id ORDER BY person_id LIMIT ${page.limit}`,
  );
  return rows.map((r) => ({ personId: r.person_id, roleIds: r.role_ids, groupIds: r.group_ids }));
}

export interface ClubAssignmentRow {
  id: string;
  personId: string;
  roleId: string;
  validFrom: Date;
  assignedByPersonId: string | null;
}

/** Open club role assignments that people gave themselves (shown on the roles page). */
export async function selfAssignments(tx: Tx, clubId: string): Promise<ClubAssignmentRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    role_id: string;
    valid_from: Date;
    assigned_by_person_id: string | null;
  }>(sql`
    SELECT a.id, a.person_id, a.role_id, a.valid_from, a.assigned_by_person_id
    FROM public.club_role_assignments a
    WHERE a.club_id = ${clubId} AND a.valid_to IS NULL AND a.assigned_by_person_id = a.person_id
    ORDER BY a.valid_from DESC LIMIT 100`);
  return rows.map(toAssignment);
}

const toAssignment = (r: {
  id: string;
  person_id: string;
  role_id: string;
  valid_from: Date;
  assigned_by_person_id: string | null;
}): ClubAssignmentRow => ({
  id: r.id,
  personId: r.person_id,
  roleId: r.role_id,
  // Raw statements return timestamps as text.
  validFrom: new Date(r.valid_from),
  assignedByPersonId: r.assigned_by_person_id,
});

/** A person's open club role assignments. */
export async function assignmentsOfPerson(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<ClubAssignmentRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    role_id: string;
    valid_from: Date;
    assigned_by_person_id: string | null;
  }>(sql`
    SELECT a.id, a.person_id, a.role_id, a.valid_from, a.assigned_by_person_id
    FROM public.club_role_assignments a
    WHERE a.club_id = ${clubId} AND a.person_id = ${personId} AND a.valid_to IS NULL
    ORDER BY a.valid_from`);
  return rows.map(toAssignment);
}

export async function insertAssignment(
  tx: Tx,
  values: { clubId: string; personId: string; roleId: string; assignedByPersonId: string | null },
): Promise<ClubAssignmentRow> {
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    role_id: string;
    valid_from: Date;
    assigned_by_person_id: string | null;
  }>(sql`
    INSERT INTO public.club_role_assignments (club_id, person_id, role_id, role, assigned_by_person_id)
    VALUES (${values.clubId}, ${values.personId}, ${values.roleId}, 'staff', ${values.assignedByPersonId})
    RETURNING id, person_id, role_id, valid_from, assigned_by_person_id`);
  return toAssignment(rows[0]!);
}

/** Moves the open assignments of a role to another role (deleting a role). */
export async function moveHolders(
  tx: Tx,
  clubId: string,
  fromRoleId: string,
  toRoleId: string,
): Promise<{ personId: string }[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    WITH c AS (
      UPDATE public.club_role_assignments SET role_id = ${toRoleId}
      WHERE club_id = ${clubId} AND role_id = ${fromRoleId} AND valid_to IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.club_role_assignments o
          WHERE o.club_id = ${clubId} AND o.person_id = club_role_assignments.person_id
            AND o.role_id = ${toRoleId} AND o.valid_to IS NULL)
      RETURNING person_id
    ), g AS (
      UPDATE public.group_memberships SET role_id = ${toRoleId}
      WHERE club_id = ${clubId} AND role_id = ${fromRoleId} AND valid_to IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.group_memberships o
          WHERE o.club_id = ${clubId} AND o.group_id = group_memberships.group_id
            AND o.person_id = group_memberships.person_id
            AND o.role_id = ${toRoleId} AND o.valid_to IS NULL)
      RETURNING person_id
    )
    SELECT person_id FROM c UNION ALL SELECT person_id FROM g`);
  return rows.map((r) => ({ personId: r.person_id }));
}

/** Ends the open assignments of a role (deleting a role without a replacement). */
export async function endHolders(
  tx: Tx,
  clubId: string,
  roleId: string,
  endedBy: string | null,
): Promise<{ personId: string }[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    WITH c AS (
      UPDATE public.club_role_assignments SET valid_to = now(), ended_by_person_id = ${endedBy}
      WHERE club_id = ${clubId} AND role_id = ${roleId} AND valid_to IS NULL
      RETURNING person_id
    ), g AS (
      UPDATE public.group_memberships SET valid_to = now()
      WHERE club_id = ${clubId} AND role_id = ${roleId} AND valid_to IS NULL
      RETURNING person_id
    )
    SELECT person_id FROM c UNION ALL SELECT person_id FROM g`);
  return rows.map((r) => ({ personId: r.person_id }));
}
