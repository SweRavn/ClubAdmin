// SPDX-License-Identifier: AGPL-3.0-only
// Duplicates among the club's members (P1.3): pairs with the same birth date
// and family name, or the same personal identity number. Club managers merge
// (with a second factor); registrars see the list.

import { enumKey } from "@clubadmin/i18n";
import { PersonName } from "@clubadmin/ui";
import { EmptyState } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getClub, getClubDuplicates, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("family.clubDuplicates.title") };
}

export default async function ClubDuplicatesPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const entry = mine.clubs.find((c) => c.club.id === club.id);
  if (!entry?.permissions.includes("club.guardians.manage")) forbidden();
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const page = await getClubDuplicates(club.id, cursor);
  const canMerge = entry.roles.includes("club_manager");
  const protectedLabel = t("protected.tooltip");
  return (
    <div className="space-y-6" data-testid="club-duplicates">
      <h1 className="text-2xl font-semibold">{t("family.clubDuplicates.title")}</h1>
      <FormError code={query.error} />
      {query.merged ? <Notice>{t("family.notices.merged")}</Notice> : null}
      <p className="text-sm text-muted">{t("family.clubDuplicates.intro")}</p>
      {page.items.length === 0 ? (
        <EmptyState title={t("family.clubDuplicates.none")} headingLevel={2} />
      ) : (
        <ul className="divide-y divide-border">
          {page.items.map((item) => (
            <li
              key={`${item.person.id}-${item.duplicate.id}`}
              className="flex flex-wrap items-center gap-3 py-3"
              data-testid="club-duplicate"
            >
              <a href={`/people/${item.person.id}?clubId=${club.id}`} className="underline">
                <PersonName person={item.person} protectedLabel={protectedLabel} />
              </a>
              <span aria-hidden="true">·</span>
              <a href={`/people/${item.duplicate.id}?clubId=${club.id}`} className="underline">
                <PersonName person={item.duplicate} protectedLabel={protectedLabel} />
              </a>
              <span className="text-sm text-muted">
                {t(enumKey("duplicateReasons", item.reason))}
              </span>
              {canMerge ? (
                <ActionForm action="merge-people">
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="personId" value={item.person.id} />
                  <input type="hidden" name="duplicatePersonId" value={item.duplicate.id} />
                  <button type="submit" className={buttonClass} data-testid="club-merge">
                    {t("family.duplicates.merge")}
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <a
          href={`/clubs/${club.id}/duplicates?cursor=${page.nextCursor}`}
          className="text-accent underline"
        >
          {t("common.loadMore")}
        </a>
      ) : null}
    </div>
  );
}
