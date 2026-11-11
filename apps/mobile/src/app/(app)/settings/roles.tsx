// SPDX-License-Identifier: AGPL-3.0-only
// My roles (P1.15 A2, read only): in each club, my roles and what they
// allow, in plain language. Roles are changed on the web.
import { enumKey } from "@clubadmin/i18n";
import { useLocale, useTranslations } from "use-intl";

import { useMyClubs, useMyPermissions } from "../../../api/queries.ts";
import { Body, Loading, Muted, Screen, Section } from "../../../components/ui.tsx";

type Role = {
  id: string;
  scope: "club" | "group";
  templateKey: string | null;
  names: { sv?: string; en?: string; nb?: string } | null;
  permissions: string[];
  groupIds: string[];
};

function ClubRoles({ clubId, clubName }: { clubId: string; clubName: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const my = useMyPermissions(clubId);
  const tr = (key: string, values?: Record<string, string | number>) =>
    t(key as never, values as never);
  const nameOf = (r: Role) => {
    const own = r.names?.[locale] ?? r.names?.sv ?? r.names?.en ?? r.names?.nb;
    if (own) return own;
    if (r.templateKey)
      return tr(enumKey(r.scope === "club" ? "roles" : "functions", r.templateKey));
    return tr("rolesAdmin.ownRole");
  };
  if (!my.data) return <Loading label={t("common.loading")} />;
  return (
    <Section title={clubName}>
      {my.data.roles.length === 0 ? (
        <Muted>{tr("rolesAdmin.myRolesNone", { club: clubName })}</Muted>
      ) : (
        (my.data.roles as Role[]).map((r) => (
          <Body key={r.id}>
            {`${nameOf(r)}${
              r.groupIds.length > 0
                ? ` (${tr("rolesAdmin.inGroups", { count: r.groupIds.length })})`
                : ""
            }: ${
              r.permissions.length === 0
                ? tr("rolesAdmin.noPermissions")
                : r.permissions
                    .map((p) =>
                      tr(`permissionCatalogue.permissions.${p.replaceAll(".", "_")}.name`),
                    )
                    .join(", ")
            }`}
          </Body>
        ))
      )}
    </Section>
  );
}

export default function MyRolesScreen() {
  const t = useTranslations();
  const clubs = useMyClubs();
  if (!clubs.data) return <Loading label={t("common.loading")} />;
  return (
    <Screen testID="my-roles-screen">
      <Muted>{t("rolesAdmin.myRolesIntro" as never)}</Muted>
      {clubs.data.clubs.map((c) => (
        <ClubRoles key={c.club.id} clubId={c.club.id} clubName={c.club.name} />
      ))}
    </Screen>
  );
}
