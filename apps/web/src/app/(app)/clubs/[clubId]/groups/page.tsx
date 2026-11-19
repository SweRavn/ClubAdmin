// SPDX-License-Identifier: AGPL-3.0-only
// The club's groups as a tree (sections, teams, training groups...), with
// kind labels. Group structure is not personal data (everyone related to
// the club sees it). The viewer's own groups and their wards' come first
// ("Mina grupper", P2.7b), the rest as the tree ("Andra grupper").
import { enumKey } from "@clubadmin/i18n";
import type { GroupResponse } from "@clubadmin/shared";
import { EmptyState, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { Notice } from "../../../../../components/form-error.tsx";
import { getClub, getClubGroups, getMyClubs, getMyGroups } from "../../../../../server/data.ts";

type Params = {
  params: Promise<{ clubId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Params) {
  const t = await getTranslations();
  return { title: t("groups.title", { club: (await getClub((await params).clubId)).name }) };
}

export default async function GroupsPage({ params, searchParams }: Params) {
  const { clubId } = await params;
  const query = (await searchParams) ?? {};
  const [t, club, groups, mine, myGroups] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubGroups(clubId),
    getMyClubs(),
    getMyGroups(),
  ]);
  const own = new Set(
    [...myGroups.groups, ...myGroups.wards.flatMap((w) => w.groups)]
      .filter((g) => g.club.id === clubId)
      .map((g) => g.group.id),
  );
  const ownGroups = groups.filter((g) => own.has(g.id));
  const canCreate =
    mine.clubs.find((c) => c.club.id === club.id)?.permissions.includes("club.groups.create") ??
    false;
  const children = new Map<string | null, GroupResponse[]>();
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const group of groups) {
    if (own.has(group.id)) continue;
    // The nearest ancestor in the tree: a parent the viewer does not see (archived)
    // or that is listed under "Mina grupper" is skipped.
    let parent = group.parentGroupId;
    while (parent && (!byId.has(parent) || own.has(parent))) {
      parent = byId.get(parent)?.parentGroupId ?? null;
    }
    children.set(parent, [...(children.get(parent) ?? []), group]);
  }

  const tree = (parent: string | null, level: number) => {
    const items = children.get(parent) ?? [];
    if (items.length === 0) return null;
    return (
      // Nested lists: screen readers announce the nesting level; links are the only stops.
      <ul className={level === 0 ? "space-y-1" : "mt-1 space-y-1 border-l border-border pl-4"}>
        {items.map((group) => (
          <li key={group.id} data-level={level + 1}>
            <span className="flex flex-wrap items-center gap-2 py-1">
              <a
                href={`/groups/${group.id}`}
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                {group.name}
              </a>
              <RoleBadge label={t(enumKey("kinds", group.kind))} />
              {group.archived ? <RoleBadge label={t("groups.archived")} /> : null}
            </span>
            {tree(group.id, level + 1)}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("groups.title", { club: club.name })}</h1>
        {canCreate ? (
          <a
            href={`/clubs/${club.id}/groups/new`}
            className={secondaryButtonClass}
            data-testid="groups-new"
          >
            {t("groupForm.newTitle")}
          </a>
        ) : null}
      </div>
      {query.deleted ? <Notice>{t("groupForm.deleted")}</Notice> : null}
      {ownGroups.length > 0 ? (
        <section aria-labelledby="my-club-groups" className="space-y-2">
          <h2 id="my-club-groups" className="text-lg font-semibold">
            {t("groups.mine")}
          </h2>
          <ul className="space-y-1" data-testid="groups-mine">
            {ownGroups.map((group) => (
              <li key={group.id} className="flex flex-wrap items-center gap-2 py-1">
                <a
                  href={`/groups/${group.id}`}
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  {group.name}
                </a>
                <RoleBadge label={t(enumKey("kinds", group.kind))} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="other-club-groups" className="space-y-2">
        {ownGroups.length > 0 ? (
          <h2 id="other-club-groups" className="text-lg font-semibold">
            {t("groups.others")}
          </h2>
        ) : null}
        <div data-testid="groups-tree">
          {tree(null, 0) ??
            (ownGroups.length > 0 ? null : <EmptyState title={t("groups.empty")} />)}
        </div>
      </section>
    </div>
  );
}
