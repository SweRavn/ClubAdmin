// SPDX-License-Identifier: AGPL-3.0-only
// A group: details, owners, leaders and members. People appear only as the
// API presents them (PersonSummary): hidden people are not in the response,
// protected people the viewer may see carry the crossed-camera icon.
import { enumKey } from "@clubadmin/i18n";
import { GROUP_FUNCTIONS, type GroupFunction } from "@clubadmin/shared";
import { EmptyState, PersonName, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { LazyGroupRoster } from "../../../../components/lazy-group-roster.tsx";
import { RosterEntry } from "../../../../components/roster-entry.tsx";
import { getClub, getClubGroups, getGroup, getGroupMembers } from "../../../../server/data.ts";

type Params = {
  params: Promise<{ groupId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};
const PAGE_SIZE = 100;

/** Roster page size: `?limit=` between 10 and 200, else 100. */
function pageSize(value: string | string[] | undefined): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(n) ? Math.min(200, Math.max(10, n)) : PAGE_SIZE;
}

export async function generateMetadata({ params }: Params) {
  return { title: (await getGroup((await params).groupId)).name };
}

export default async function GroupPage({ params, searchParams }: Params) {
  const { groupId } = await params;
  const limit = pageSize((await searchParams)?.limit);
  const [t, group, roster] = await Promise.all([
    getTranslations(),
    getGroup(groupId),
    getGroupMembers(groupId, limit),
  ]);
  const [club, groups] = await Promise.all([getClub(group.clubId), getClubGroups(group.clubId)]);
  const parent = groups.find((g) => g.id === group.parentGroupId) ?? null;
  const subgroups = groups.filter((g) => g.parentGroupId === group.id && !g.archived);
  const leaders =
    roster?.items.filter((entry) => entry.functions.some((fn) => fn !== "member")) ?? [];
  const protectedLabel = t("protected.tooltip");
  const profile = (personId: string) => `/people/${personId}?clubId=${group.clubId}`;
  const rosterTexts = {
    protectedTooltip: protectedLabel,
    functions: Object.fromEntries(
      GROUP_FUNCTIONS.map((fn) => [fn, t(enumKey("functions", fn))]),
    ) as Record<GroupFunction, string>,
    otherFunction: t("common.other"),
  };

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
          {parent ? (
            <>
              {" / "}
              <a href={`/groups/${parent.id}`} className="underline">
                {parent.name}
              </a>
            </>
          ) : null}
        </p>
        <h1
          className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold"
          data-testid="group-name"
        >
          {group.name}
          <RoleBadge label={t(enumKey("kinds", group.kind))} />
          {group.archived ? <RoleBadge label={t("groups.archived")} /> : null}
        </h1>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {group.sport ? (
            <>
              <dt className="text-muted">{t("group.sport")}</dt>
              <dd>{group.sport}</dd>
            </>
          ) : null}
          {group.birthYearFrom !== null && group.birthYearTo !== null ? (
            <>
              <dt className="text-muted">{t("group.birthYears")}</dt>
              <dd>
                {t("group.birthYearRange", {
                  from: String(group.birthYearFrom),
                  to: String(group.birthYearTo),
                })}
              </dd>
            </>
          ) : null}
          {group.capacity !== null ? (
            <>
              <dt className="text-muted">{t("group.capacity")}</dt>
              <dd>{group.capacity}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <section aria-labelledby="group-owners">
        <h2 id="group-owners" className="mb-2 text-lg font-semibold">
          {t("group.owners")}
        </h2>
        {group.owners.length === 0 ? (
          <p className="text-muted">{t("group.noOwners")}</p>
        ) : (
          <ul className="space-y-1" data-testid="group-owners">
            {group.owners.map((person) => (
              <li key={person.id}>
                <PersonName
                  person={person}
                  href={profile(person.id)}
                  protectedLabel={protectedLabel}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {roster === null ? (
        <EmptyState title={t("group.members")} headingLevel={2}>
          <p data-testid="roster-hidden">{t("group.rosterHidden")}</p>
        </EmptyState>
      ) : (
        <>
          <section aria-labelledby="group-leaders">
            <h2 id="group-leaders" className="mb-2 text-lg font-semibold">
              {t("group.leaders")}
            </h2>
            {leaders.length === 0 ? (
              <p className="text-muted">{t("group.noLeaders")}</p>
            ) : (
              <ul className="space-y-1" data-testid="group-leaders">
                {leaders.map((entry) => (
                  <li key={entry.person.id} className="flex flex-wrap items-center gap-2">
                    <PersonName
                      person={entry.person}
                      href={profile(entry.person.id)}
                      protectedLabel={protectedLabel}
                    />
                    {entry.functions
                      .filter((fn) => fn !== "member")
                      .map((fn) => (
                        <RoleBadge key={fn} tone="accent" label={t(enumKey("functions", fn))} />
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="group-members-heading">
            <h2
              id="group-members-heading"
              className="mb-2 flex items-baseline gap-2 text-lg font-semibold"
            >
              {t("group.members")}
              <span className="text-sm font-normal text-muted" data-testid="member-count">
                {t("group.memberCount", { count: roster.totalCount })}
              </span>
            </h2>
            {roster.items.length === 0 ? (
              <p className="text-muted">{t("group.noMembers")}</p>
            ) : roster.nextCursor ? (
              <LazyGroupRoster
                groupId={group.id}
                clubId={group.clubId}
                initialPage={{ items: roster.items, nextCursor: roster.nextCursor }}
                pageSize={limit}
                texts={{
                  ...rosterTexts,
                  loadMore: t("common.loadMore"),
                  loading: t("common.loading"),
                  failed: t("common.loadMoreFailed"),
                }}
              />
            ) : (
              <ul className="divide-y divide-border" data-testid="group-members">
                {roster.items.map((entry) => (
                  <li key={entry.person.id} className="py-2">
                    <RosterEntry entry={entry} clubId={group.clubId} texts={rosterTexts} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {subgroups.length > 0 ? (
        <section aria-labelledby="subgroups">
          <h2 id="subgroups" className="mb-2 text-lg font-semibold">
            {t("group.subgroups", { group: group.name })}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {subgroups.map((g) => (
              <li key={g.id}>
                <a
                  href={`/groups/${g.id}`}
                  className="inline-block rounded-md border border-border px-3 py-1.5 hover:bg-surface"
                >
                  {g.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
