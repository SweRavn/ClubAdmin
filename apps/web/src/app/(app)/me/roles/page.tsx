// SPDX-License-Identifier: AGPL-3.0-only
// My roles (P1.15 A2): in each club, my roles and what they allow, in plain
// language. Notices about changed or ended roles link here.
import { getLocale, getTranslations } from "next-intl/server";

import { permissionName, roleName } from "../../../../components/roles.ts";
import { getMyClubs, getMyPermissions } from "../../../../server/data.ts";

export async function generateMetadata() {
  return { title: (await getTranslations())("rolesAdmin.myRoles") };
}

export default async function MyRolesPage() {
  const [t, locale, mine] = await Promise.all([getTranslations(), getLocale(), getMyClubs()]);
  const clubs = await Promise.all(
    mine.clubs.map(async (c) => ({ club: c.club, my: await getMyPermissions(c.club.id) })),
  );
  return (
    <div className="space-y-6" data-testid="my-roles">
      <h1 className="text-2xl font-semibold">{t("rolesAdmin.myRoles")}</h1>
      <p>{t("rolesAdmin.myRolesIntro")}</p>
      <a href="/help/roles" className="text-sm text-accent underline">
        {t("rolesAdmin.helpLink")}
      </a>
      {clubs.map(({ club, my }) => (
        <section key={club.id} className="space-y-2" aria-labelledby={`club-${club.id}`}>
          <h2 id={`club-${club.id}`} className="text-lg font-semibold">
            {club.name}
          </h2>
          {my.roles.length === 0 ? (
            <p className="text-sm text-muted">{t("rolesAdmin.myRolesNone", { club: club.name })}</p>
          ) : (
            <ul className="space-y-3">
              {my.roles.map((r) => (
                <li key={r.id} className="rounded-lg border border-border bg-raised p-3">
                  <p className="font-medium">
                    {roleName(t, locale, r)}
                    {r.groupIds.length > 0 ? (
                      <span className="ml-2 text-sm text-muted">
                        {t("rolesAdmin.inGroups", { count: r.groupIds.length })}
                      </span>
                    ) : null}
                  </p>
                  {r.permissions.length === 0 ? (
                    <p className="text-sm">{t("rolesAdmin.noPermissions")}</p>
                  ) : (
                    <ul className="list-disc pl-5 text-sm">
                      {r.permissions.map((p) => (
                        <li key={p}>{permissionName(t, p)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
