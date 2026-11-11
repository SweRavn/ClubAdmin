// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles (P1.15 A2) in the web app: a role's name in the
// viewer's language (the club's own name, or the catalogue's for a template
// role) and a permission's texts from the message catalogue.
import { enumKey } from "@clubadmin/i18n";
import { PERMISSION_AREAS, PERMISSION_CATALOGUE, type RolePermission } from "@clubadmin/shared";

/** next-intl's typed translator, or any translator (keys are built here). */
type Translate = (key: never, values?: never) => string;
const tr = (t: Translate, key: string, values?: Record<string, string | number>) =>
  t(key as never, values as never);

export interface NamedRole {
  scope: "club" | "group";
  templateKey: string | null;
  names: { sv?: string | undefined; en?: string | undefined; nb?: string | undefined } | null;
}

export function roleName(t: Translate, locale: string, role: NamedRole): string {
  const names = role.names ?? {};
  const own = names[locale as "sv" | "en" | "nb"] ?? names.sv ?? names.en ?? names.nb;
  if (own) return own;
  if (role.templateKey) {
    return tr(t, enumKey(role.scope === "club" ? "roles" : "functions", role.templateKey));
  }
  return tr(t, "rolesAdmin.ownRole");
}

const keyOf = (permission: string) => permission.replaceAll(".", "_");

export const permissionName = (t: Translate, permission: string) =>
  tr(t, `permissionCatalogue.permissions.${keyOf(permission)}.name`);
export const permissionDescription = (t: Translate, permission: string) =>
  tr(t, `permissionCatalogue.permissions.${keyOf(permission)}.description`);
export const permissionExample = (t: Translate, permission: string) =>
  tr(t, `permissionCatalogue.permissions.${keyOf(permission)}.example`);

export const isSensitive = (permission: string): boolean => {
  const entry = PERMISSION_CATALOGUE[permission as RolePermission];
  return entry?.kind === "role" && entry.sensitive;
};

/** The role permissions a role of the scope may hold, grouped by area in catalogue order. */
export function permissionsByArea(
  scope: "club" | "group",
): { area: string; permissions: string[] }[] {
  return PERMISSION_AREAS.map((area) => ({
    area,
    permissions: Object.entries(PERMISSION_CATALOGUE)
      .filter(
        ([, e]) =>
          e.kind === "role" && e.area === area && (scope === "club" || e.scope === "group"),
      )
      .map(([p]) => p),
  })).filter((a) => a.permissions.length > 0);
}

/** A role's permissions in one sentence: the first few names, "and N more". */
export function roleSummary(t: Translate, permissions: readonly string[], shown = 3): string {
  if (permissions.length === 0) return tr(t, "rolesAdmin.noPermissions");
  const names = permissions.slice(0, shown).map((p) => permissionName(t, p));
  const rest = permissions.length - shown;
  return rest > 0
    ? `${names.join(", ")} ${tr(t, "rolesAdmin.summaryMore", { count: rest })}`
    : names.join(", ");
}

/** An area's name ("Medlemmar", "Ekonomi", ...). */
export const areaName = (t: Translate, area: string) => tr(t, `permissionCatalogue.areas.${area}`);
