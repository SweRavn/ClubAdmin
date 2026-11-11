// SPDX-License-Identifier: AGPL-3.0-only
// Who holds a permission (P1.15, ADR 0046): recipients are asked for by what
// they may do, never by a role or function name. Statements to embed in a
// recipient query; they read in the club's tenant scope (set the club first)
// through club_role_assignments_role_idx / group_memberships_role_idx and the
// roles' (role_id, permission) index.

import { sql } from "@clubadmin/db";
import type { RolePermission } from "@clubadmin/shared";

/** People holding the permission through a club role in the club (each once). */
export const clubHolders = (clubId: string, permission: RolePermission) => sql`
  SELECT DISTINCT r.person_id FROM public.club_role_assignments r
  JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.role_id
  WHERE r.club_id = ${clubId} AND r.valid_to IS NULL AND rp.permission = ${permission}`;

/** People holding any of the permissions through a role held in one of the activity's groups. */
export const activityGroupHolders = (
  activityId: string,
  permissions: readonly RolePermission[],
) => sql`
  SELECT gm.person_id FROM public.group_memberships gm
  JOIN public.activity_groups ag ON ag.group_id = gm.group_id AND ag.activity_id = ${activityId}
  JOIN public.role_permissions rp ON rp.club_id = gm.club_id AND rp.role_id = gm.role_id
  WHERE gm.valid_to IS NULL
    AND rp.permission = ANY (${`{${permissions.join(",")}}`}::text[])`;
