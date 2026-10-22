// SPDX-License-Identifier: AGPL-3.0-only
// Club overview: name, logo, managers, top-level groups, the club's time zone.
import { enumKey } from "@clubadmin/i18n";
import { EmptyState, PersonName } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ClubTime } from "../../../../components/club-time.tsx";
import { Notice } from "../../../../components/form-error.tsx";
import { getClub, getClubGroups, getMyClubs } from "../../../../server/data.ts";

type Params = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Params) {
  return { title: (await getClub((await params).clubId)).name };
}

export default async function ClubPage({ params, searchParams }: Params) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, groups, mine] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubGroups(clubId),
    getMyClubs(),
  ]);
  const canManage =
    mine.clubs.find((c) => c.club.id === club.id)?.permissions.includes("club.roles.manage") ??
    false;
  const topLevel = groups.filter((g) => g.parentGroupId === null && !g.archived);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        {club.logo ? (
          <img
            src={club.logo}
            alt={t("club.logo", { club: club.name })}
            width={64}
            height={64}
            className="rounded-md"
          />
        ) : null}
        <h1 className="text-2xl font-semibold" data-testid="club-name">
          {club.name}
        </h1>
      </div>

      {query.welcome ? <Notice>{t("club.welcome")}</Notice> : null}
      {query.created ? <Notice>{t("club.created")}</Notice> : null}

      <section
        aria-labelledby="club-details"
        className="rounded-lg border border-border bg-raised p-4"
      >
        <h2 id="club-details" className="mb-2 text-lg font-semibold">
          {t("club.details")}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">{t("club.timeZone")}</dt>
          <dd>{club.timeZone}</dd>
          <dt className="text-muted">{t("club.localTime")}</dt>
          <dd data-testid="club-time">
            <ClubTime value={new Date()} timeZone={club.timeZone} timeStyle="short" />
          </dd>
        </dl>
      </section>

      <section aria-labelledby="club-managers">
        <div className="mb-2 flex items-baseline gap-3">
          <h2 id="club-managers" className="text-lg font-semibold">
            {t("club.managers")}
          </h2>
          {canManage ? (
            <a href={`/clubs/${club.id}/managers`} className="text-sm text-accent underline">
              {t("managers.manage")}
            </a>
          ) : null}
        </div>
        {club.managers.length === 0 ? (
          <p className="text-muted">{t("club.noManagers")}</p>
        ) : (
          <ul className="space-y-1" data-testid="club-managers">
            {club.managers.map((person) => (
              <li key={person.id}>
                <PersonName
                  person={person}
                  href={`/people/${person.id}?clubId=${club.id}`}
                  protectedLabel={t("protected.tooltip")}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="club-groups">
        <div className="mb-2 flex items-baseline gap-3">
          <h2 id="club-groups" className="text-lg font-semibold">
            {t("club.groups")}
          </h2>
          <a href={`/clubs/${club.id}/groups`} className="text-sm text-accent underline">
            {t("club.allGroups")}
          </a>
        </div>
        {topLevel.length === 0 ? (
          <EmptyState title={t("groups.empty")} headingLevel={3} />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {topLevel.map((group) => (
              <li key={group.id}>
                <a
                  href={`/groups/${group.id}`}
                  className="inline-block rounded-md border border-border px-3 py-1.5 hover:bg-surface"
                >
                  {group.name}{" "}
                  <span className="text-sm text-muted">· {t(enumKey("kinds", group.kind))}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
