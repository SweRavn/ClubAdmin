// SPDX-License-Identifier: AGPL-3.0-only
// What accepting an invitation gives (P1.15 A4): the groups, each with its
// role, and the club role, on the landing pages of a link and of a code.
import type { InvitationLookup } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { roleName } from "./roles.ts";

export async function InvitationGifts({ invitation }: { invitation: InvitationLookup }) {
  if (invitation.groups.length === 0 && !invitation.clubRole) return null;
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  return (
    <section className="space-y-1" data-testid="invitation-gifts">
      <h2 className="text-lg font-semibold">{t("joinLanding.gives")}</h2>
      <ul className="list-disc pl-5">
        {invitation.groups.map((g) => (
          <li key={g.groupId} data-testid="invitation-gift-group">
            {t("joinLanding.groupAs", {
              group: g.groupName,
              role: roleName(t, locale, { ...g.role, scope: "group" }),
            })}
          </li>
        ))}
        {invitation.clubRole ? (
          <li data-testid="invitation-gift-role">
            {t("joinLanding.clubRole", {
              role: roleName(t, locale, { ...invitation.clubRole, scope: "club" }),
            })}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
