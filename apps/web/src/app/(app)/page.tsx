// SPDX-License-Identifier: AGPL-3.0-only
// Home: my clubs, my groups and my children's groups, with role badges; the
// onboarding placeholder for people without a club.
import { enumKey } from "@clubadmin/i18n";
import type { MyGroups } from "@clubadmin/shared";
import { EmptyState, personLabel, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { getMe, getMyClubs, getMyGroups, getMyWards } from "../../server/data.ts";

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t("home.title") };
}

export default async function HomePage() {
  const [t, me, clubs, groups, wards] = await Promise.all([
    getTranslations(),
    getMe(),
    getMyClubs(),
    getMyGroups(),
    getMyWards(),
  ]);

  if (clubs.clubs.length === 0 && groups.groups.length === 0 && groups.wards.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">
          {t("home.greeting", { name: personLabel(me.person) })}
        </h1>
        <div data-testid="onboarding">
          <EmptyState
            title={t("onboarding.title")}
            actions={
              <>
                <button
                  type="button"
                  disabled
                  aria-describedby="onboarding-soon"
                  className={disabledButton}
                >
                  {t("onboarding.findClub")}
                </button>
                <button
                  type="button"
                  disabled
                  aria-describedby="onboarding-soon"
                  className={disabledButton}
                >
                  {t("onboarding.createClub")}
                </button>
              </>
            }
          >
            <p>{t("onboarding.text")}</p>
            <p id="onboarding-soon" className="mt-1 text-sm">
              {t("onboarding.comingSoon")}
            </p>
          </EmptyState>
        </div>
      </div>
    );
  }

  const wardName = new Map(wards.wards.map((w) => [w.person.id, personLabel(w.person)]));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">
        {t("home.greeting", { name: personLabel(me.person) })}
      </h1>

      {clubs.clubs.length > 0 ? (
        <section aria-labelledby="my-clubs">
          <h2 id="my-clubs" className="mb-3 text-xl font-semibold">
            {t("home.myClubs")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="my-clubs">
            {clubs.clubs.map(({ club, roles, membership }) => (
              <li key={club.id} className="rounded-lg border border-border bg-raised p-4">
                <a
                  href={`/clubs/${club.id}`}
                  className="font-semibold text-accent underline-offset-2 hover:underline"
                >
                  {club.name}
                </a>
                <div className="mt-2 flex flex-wrap gap-1">
                  {membership ? (
                    <RoleBadge label={t(enumKey("membershipStatus", membership.status))} />
                  ) : null}
                  {roles.map((role) => (
                    <RoleBadge key={role} tone="accent" label={t(enumKey("roles", role))} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="my-groups">
        <h2 id="my-groups" className="mb-3 text-xl font-semibold">
          {t("home.myGroups")}
        </h2>
        <GroupList groups={groups.groups} empty={t("home.noGroups")} testId="my-groups" />
      </section>

      {groups.wards.map((ward) =>
        wardName.has(ward.personId) ? (
          <section key={ward.personId} aria-labelledby={`ward-${ward.personId}`}>
            <h2 id={`ward-${ward.personId}`} className="mb-3 text-xl font-semibold">
              {t("home.wardGroups", { name: wardName.get(ward.personId)! })}
            </h2>
            <GroupList groups={ward.groups} empty={t("home.noWardGroups")} testId="ward-groups" />
          </section>
        ) : null,
      )}
    </div>
  );
}

const disabledButton =
  "rounded-md border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60";

async function GroupList({
  groups,
  empty,
  testId,
}: {
  groups: MyGroups["groups"];
  empty: string;
  testId: string;
}) {
  const t = await getTranslations();
  if (groups.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <ul
      className="divide-y divide-border rounded-lg border border-border bg-raised"
      data-testid={testId}
    >
      {groups.map(({ group, club, functions }) => (
        <li key={group.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
          <a
            href={`/groups/${group.id}`}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            {group.name}
          </a>
          <span className="text-sm text-muted">
            {t(enumKey("kinds", group.kind))} · {club.name}
          </span>
          <span className="ml-auto flex flex-wrap gap-1">
            {functions.map((fn) => (
              <RoleBadge
                key={fn}
                tone={fn === "member" ? "neutral" : "accent"}
                label={t(enumKey("functions", fn))}
              />
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
