// SPDX-License-Identifier: AGPL-3.0-only
// All waiting lists of the club (P1.10b, ADR 0043), for club managers and
// registrars: per group the places, waiting, offers out and accepted entries
// awaiting the club; and every out-of-turn offer or admission and every
// queue bypass with its reason and who decided, newest first.
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel, PersonName } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { getClub, getClubWaitlists, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("waitlist.clubTitle") };
}

export default async function ClubWaitlistsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, mine] = await Promise.all([getTranslations(), getLocale(), getMyClubs()]);
  const allowed = mine.clubs
    .find((c) => c.club.id === clubId)
    ?.permissions.includes("club.waitlists.read");
  if (!allowed) forbidden();
  const cursor =
    typeof query.cursor === "string" && /^[0-9a-f-]{36}$/.test(query.cursor) ? query.cursor : null;
  const [club, view] = await Promise.all([getClub(clubId), getClubWaitlists(clubId, cursor)]);
  const protectedLabel = t("protected.tooltip");

  return (
    <div className="space-y-8" data-testid="club-waitlists">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("waitlist.clubTitle")}</h1>
      </div>

      {cursor === null ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("waitlist.clubGroups")}</h2>
          {view.groups.length === 0 ? (
            <p className="text-muted">{t("waitlist.empty")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {view.groups.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                  <a href={`/groups/${g.id}/waitlist`} className="font-medium underline">
                    {g.name}
                  </a>
                  <span className="text-sm text-muted">
                    {g.capacity === null
                      ? t("waitlist.summaryUnlimited", {
                          occupied: g.occupied,
                          offers: g.offers,
                          waiting: g.waiting,
                        })
                      : t("waitlist.summary", {
                          occupied: g.occupied,
                          capacity: g.capacity,
                          offers: g.offers,
                          waiting: g.waiting,
                        })}
                  </span>
                  {g.accepted > 0 ? (
                    <span className="text-sm">
                      {t("waitlist.awaitingClubCount", { count: g.accepted })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="space-y-2" data-testid="waitlist-decisions">
        <h2 className="text-lg font-semibold">{t("waitlist.decisionsTitle")}</h2>
        {view.decisions.length === 0 ? (
          <p className="text-muted">{t("waitlist.noDecisions")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {view.decisions.map((d) => (
              <li key={d.id} className="space-y-1 px-4 py-3" data-testid="waitlist-decision">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {t(enumKey("waitlist.decisionKinds", d.kind))}
                  </span>
                  <span>· {d.group.name} ·</span>
                  <PersonName person={d.person} protectedLabel={protectedLabel} />
                </div>
                <p className="text-sm">{d.reason}</p>
                <p className="text-sm text-muted">
                  {formatDateTime(d.decidedAt, {
                    locale,
                    timeZone: club.timeZone,
                    dateStyle: "medium",
                  })}
                  {d.decidedBy
                    ? ` · ${t("waitlist.decidedBy", { name: personLabel(d.decidedBy) })}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {view.nextCursor ? (
          <a href={`/clubs/${club.id}/waitlists?cursor=${view.nextCursor}`} className="underline">
            {t("waitlist.more")}
          </a>
        ) : null}
      </section>
    </div>
  );
}
