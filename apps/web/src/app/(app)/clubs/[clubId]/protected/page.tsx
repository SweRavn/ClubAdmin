// SPDX-License-Identifier: AGPL-3.0-only
// The club's protected members (P1.12): the register filtered to members
// with protected identity, with the source and when the club set it. Club
// managers only; linked from the club page and from the managers' notices.
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, PersonName } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { getClub, getMyClubs, getRegister } from "../../../../../server/data.ts";

type Props = { params: Promise<{ clubId: string }> };

export async function generateMetadata() {
  return { title: (await getTranslations())("protection.protectedMembers") };
}

export default async function ProtectedMembersPage({ params }: Props) {
  const { clubId } = await params;
  const [t, locale, timeZone, club, mine] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getClub(clubId),
    getMyClubs(),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.profile_views.read")) forbidden();
  const register = await getRegister(club.id, "protected=only&limit=200");
  const protectedLabel = t("protected.tooltip");
  return (
    <div className="space-y-4" data-testid="protected-members">
      <h1 className="text-2xl font-semibold">{t("protection.protectedMembers")}</h1>
      <p className="text-muted">{t("protection.protectedMembersIntro")}</p>
      <p className="text-sm">
        <a href="/help/protected-identity" className="underline">
          {t("protection.help")}
        </a>
      </p>
      {register.items.length === 0 ? (
        <p className="text-muted">{t("protection.protectedEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {register.items.map((m) => (
            <li
              key={m.person.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="protected-member"
            >
              <a href={`/people/${m.person.id}?clubId=${club.id}`}>
                <PersonName person={m.person} protectedLabel={protectedLabel} />
              </a>
              {m.protection ? (
                <span className="text-sm text-muted">
                  {t(enumKey("protection.sources", m.protection.source))}
                  {m.protection.clubSetAt
                    ? ` · ${t("protection.since")} ${formatDateTime(m.protection.clubSetAt, {
                        locale,
                        timeZone,
                        dateStyle: "medium",
                      })}`
                    : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
