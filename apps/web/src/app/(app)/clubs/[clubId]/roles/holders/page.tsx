// SPDX-License-Identifier: AGPL-3.0-only
// Who may do something (P1.15 A2): the people holding a permission in the
// club, through which roles and in how many groups. Names through the person
// presenter; keyset-paginated.
import { isRolePermission } from "@clubadmin/shared";
import { PersonName } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  permissionDescription,
  permissionName,
  roleName,
} from "../../../../../../components/roles.ts";
import { getClub, getClubRoles, getPermissionHolders } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("rolesAdmin.whoCan") };
}

export default async function PermissionHoldersPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const permission = typeof query.permission === "string" ? query.permission : "";
  if (!isRolePermission(permission)) notFound();
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, locale, club, roles, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getClubRoles(clubId),
    getPermissionHolders(clubId, permission, cursor),
  ]);
  const byId = new Map(roles.items.map((r) => [r.id, r]));
  return (
    <div className="space-y-6" data-testid="permission-holders">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}/roles`} className="underline">
          {t("rolesAdmin.title")}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">
        {t("rolesAdmin.holdersTitle", { permission: permissionName(t, permission) })}
      </h1>
      <p>{permissionDescription(t, permission)}</p>
      {page.items.length === 0 ? (
        <p>{t("rolesAdmin.holdersNone")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
          {page.items.map((h) => (
            <li key={h.person.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <PersonName
                person={h.person}
                href={`/people/${h.person.id}?clubId=${club.id}`}
                protectedLabel={t("protected.tooltip")}
              />
              <span className="text-sm text-muted">
                {t("rolesAdmin.holdersVia", {
                  roles: h.roleIds
                    .map((id) => byId.get(id))
                    .filter((r) => r !== undefined)
                    .map((r) => roleName(t, locale, r))
                    .join(", "),
                })}
                {h.groupIds.length > 0
                  ? ` · ${t("rolesAdmin.holdersGroups", { count: h.groupIds.length })}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <a
          href={`/clubs/${club.id}/roles/holders?permission=${encodeURIComponent(permission)}&cursor=${page.nextCursor}`}
          className="text-sm text-accent underline"
        >
          {t("rolesAdmin.more")}
        </a>
      ) : null}
    </div>
  );
}
