// SPDX-License-Identifier: AGPL-3.0-only
// The club's groups as a tree (sections, teams, training groups...), with
// kind labels. Group structure is not personal data (everyone related to
// the club sees it).
import { enumKey } from "@clubadmin/i18n";
import type { GroupResponse } from "@clubadmin/shared";
import { EmptyState, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { Notice } from "../../../../../components/form-error.tsx";
import { getClub, getClubGroups, getMyClubs } from "../../../../../server/data.ts";

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
  const [t, club, groups, mine] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubGroups(clubId),
    getMyClubs(),
  ]);
  const canCreate =
    mine.clubs.find((c) => c.club.id === club.id)?.permissions.includes("club.groups.create") ??
    false;
  const children = new Map<string | null, GroupResponse[]>();
  const ids = new Set(groups.map((g) => g.id));
  for (const group of groups) {
    // A parent the viewer does not see (archived) puts the group at the top.
    const parent = group.parentGroupId && ids.has(group.parentGroupId) ? group.parentGroupId : null;
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
      <div data-testid="groups-tree">
        {tree(null, 0) ?? <EmptyState title={t("groups.empty")} />}
      </div>
    </div>
  );
}
