// SPDX-License-Identifier: AGPL-3.0-only
// Club types and their templates (P1.15 B, migration 0036): global tables,
// read by everyone logged in, written by operators (RLS).
import { sql, type Tx } from "@clubadmin/db";

export interface TemplateRoleRow {
  id: string;
  key: string;
  scope: "club" | "group";
  names: Record<string, string> | null;
  descriptions: Record<string, string> | null;
  locked: boolean;
  sortOrder: number;
  permissions: string[];
}

export interface ClubTypeRow {
  id: string;
  key: string;
  names: Record<string, string>;
  descriptions: Record<string, string> | null;
  active: boolean;
  sortOrder: number;
  roles: TemplateRoleRow[];
}

type RawType = {
  id: string;
  key: string;
  names: Record<string, string>;
  descriptions: Record<string, string> | null;
  active: boolean;
  sort_order: number;
  roles: TemplateRoleRow[];
};

/** A type's columns with its roles and their permissions (one statement). */
const TYPE_COLUMNS = sql`ct.id, ct.key, ct.names, ct.descriptions, ct.active, ct.sort_order,
  coalesce((SELECT json_agg(json_build_object(
      'id', r.id, 'key', r.key, 'scope', r.scope, 'names', r.names,
      'descriptions', r.descriptions, 'locked', r.locked, 'sortOrder', r.sort_order,
      'permissions', coalesce((SELECT array_agg(p.permission ORDER BY p.permission)
        FROM public.club_type_role_permissions p WHERE p.club_type_role_id = r.id), '{}'))
    ORDER BY r.scope, r.sort_order, r.key)
    FROM public.club_type_roles r WHERE r.club_type_id = ct.id), '[]') AS roles`;

const toType = (r: RawType): ClubTypeRow => ({
  id: r.id,
  key: r.key,
  names: r.names,
  descriptions: r.descriptions,
  active: r.active,
  sortOrder: r.sort_order,
  roles: r.roles,
});

export async function listTypes(tx: Tx, options: { activeOnly: boolean }): Promise<ClubTypeRow[]> {
  const { rows } = await tx.execute<RawType>(sql`
    SELECT ${TYPE_COLUMNS} FROM public.club_types ct
    ${options.activeOnly ? sql`WHERE ct.active` : sql``}
    ORDER BY ct.sort_order, ct.key`);
  return rows.map(toType);
}

export async function getType(tx: Tx, id: string): Promise<ClubTypeRow | null> {
  const { rows } = await tx.execute<RawType>(sql`
    SELECT ${TYPE_COLUMNS} FROM public.club_types ct WHERE ct.id = ${id}`);
  return rows[0] ? toType(rows[0]) : null;
}

/** A type's ID and whether it is active, by ID or key (choosing a type for a new club). */
export async function typeRef(
  tx: Tx,
  ref: { id: string } | { key: string },
): Promise<{ id: string; active: boolean } | null> {
  const { rows } = await tx.execute<{ id: string; active: boolean }>(sql`
    SELECT id, active FROM public.club_types
    WHERE ${"id" in ref ? sql`id = ${ref.id}` : sql`key = ${ref.key}`}`);
  return rows[0] ?? null;
}

/** The club's type with its template (the club's own row, in its tenant scope). */
export async function typeOfClub(tx: Tx, clubId: string): Promise<ClubTypeRow | null> {
  const { rows } = await tx.execute<RawType>(sql`
    SELECT ${TYPE_COLUMNS} FROM public.clubs c
    JOIN public.club_types ct ON ct.id = c.club_type_id
    WHERE c.id = ${clubId}`);
  return rows[0] ? toType(rows[0]) : null;
}

export async function insertType(
  tx: Tx,
  values: {
    key: string;
    names: Record<string, string>;
    descriptions: Record<string, string> | null;
    sortOrder: number;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.club_types (key, names, descriptions, sort_order)
    VALUES (${values.key}, ${JSON.stringify(values.names)}::jsonb,
      ${values.descriptions ? JSON.stringify(values.descriptions) : null}::jsonb, ${values.sortOrder})
    RETURNING id`);
  return rows[0]!.id;
}

export async function updateType(
  tx: Tx,
  id: string,
  changes: {
    names?: Record<string, string>;
    descriptions?: Record<string, string> | null;
    active?: boolean;
    sortOrder?: number;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.club_types SET
      names = coalesce(${changes.names ? JSON.stringify(changes.names) : null}::jsonb, names),
      descriptions = CASE WHEN ${"descriptions" in changes}
        THEN ${changes.descriptions ? JSON.stringify(changes.descriptions) : null}::jsonb
        ELSE descriptions END,
      active = coalesce(${changes.active ?? null}::boolean, active),
      sort_order = coalesce(${changes.sortOrder ?? null}::int, sort_order)
    WHERE id = ${id}`);
}

export async function insertRole(
  tx: Tx,
  values: {
    clubTypeId: string;
    key: string;
    scope: "club" | "group";
    names: Record<string, string> | null;
    descriptions: Record<string, string> | null;
    locked: boolean;
    sortOrder: number;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.club_type_roles
      (club_type_id, key, scope, names, descriptions, locked, sort_order)
    VALUES (${values.clubTypeId}, ${values.key}, ${values.scope},
      ${values.names ? JSON.stringify(values.names) : null}::jsonb,
      ${values.descriptions ? JSON.stringify(values.descriptions) : null}::jsonb,
      ${values.locked}, ${values.sortOrder})
    RETURNING id`);
  return rows[0]!.id;
}

export async function updateRole(
  tx: Tx,
  roleId: string,
  changes: {
    names?: Record<string, string> | null;
    descriptions?: Record<string, string> | null;
    sortOrder?: number;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.club_type_roles SET
      names = CASE WHEN ${"names" in changes}
        THEN ${changes.names ? JSON.stringify(changes.names) : null}::jsonb ELSE names END,
      descriptions = CASE WHEN ${"descriptions" in changes}
        THEN ${changes.descriptions ? JSON.stringify(changes.descriptions) : null}::jsonb
        ELSE descriptions END,
      sort_order = coalesce(${changes.sortOrder ?? null}::int, sort_order)
    WHERE id = ${roleId}`);
}

/** Sets a template role's permissions (adds and removes the difference). */
export async function setRolePermissions(
  tx: Tx,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  const list = `{${permissions.join(",")}}`;
  await tx.execute(sql`
    DELETE FROM public.club_type_role_permissions
    WHERE club_type_role_id = ${roleId} AND NOT (permission = ANY (${list}::text[]))`);
  if (permissions.length > 0) {
    await tx.execute(sql`
      INSERT INTO public.club_type_role_permissions (club_type_role_id, permission)
      SELECT ${roleId}, p FROM unnest(${list}::text[]) p
      ON CONFLICT (club_type_role_id, permission) DO NOTHING`);
  }
}

export async function deleteRole(tx: Tx, roleId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM public.club_type_roles WHERE id = ${roleId}`);
}
