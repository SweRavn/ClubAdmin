// SPDX-License-Identifier: AGPL-3.0-only
// The club's profile views (P1.12): what the club logs (views of protected
// members only, or every profile view) and the log with filters. Club
// managers with a second factor; members who left appear as "a former
// member".
import { isUuid } from "@clubadmin/shared";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { ProfileViewList } from "../../../../../components/protection.tsx";
import { getClub, getClubProfileViews, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export async function generateMetadata() {
  return { title: (await getTranslations())("protection.profileViews") };
}

export default async function ProfileViewsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.profile_views.read")) forbidden();
  const filter = new URLSearchParams();
  for (const key of ["personId", "viewerId", "cursor"] as const) {
    if (isUuid(one(query[key]))) filter.set(key, one(query[key]));
  }
  if (one(query.protected) === "only") filter.set("protected", "only");
  const log = await getClubProfileViews(club.id, filter.toString());
  const next = new URLSearchParams(filter);
  if (log.nextCursor) next.set("cursor", log.nextCursor);
  return (
    <div className="space-y-6" data-testid="profile-views">
      <h1 className="text-2xl font-semibold">{t("protection.profileViews")}</h1>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("protection.modeSaved")}</Notice> : null}
      <section
        aria-labelledby="logging-mode"
        className="space-y-2 rounded-lg border border-border p-4"
      >
        <h2 id="logging-mode" className="text-lg font-semibold">
          {t("protection.mode")}
        </h2>
        <ActionForm action="set-profile-view-logging" className="space-y-2">
          <input type="hidden" name="clubId" value={club.id} />
          {(["protected_only", "all"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="mode"
                value={mode}
                defaultChecked={log.mode === mode}
                data-testid={`logging-${mode}`}
              />
              <span>{t(`protection.modes.${mode}`)}</span>
            </label>
          ))}
          <p className="text-sm text-muted">{t("protection.modeHint")}</p>
          <button type="submit" className={buttonClass} data-testid="logging-save">
            {t("protection.saveMode")}
          </button>
        </ActionForm>
      </section>
      <form method="get" className="flex flex-wrap items-end gap-3">
        {filter.get("personId") ? (
          <input type="hidden" name="personId" value={filter.get("personId")!} />
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="protected"
            value="only"
            defaultChecked={filter.get("protected") === "only"}
          />
          <span>{t("protection.protectedOnly")}</span>
        </label>
        <button type="submit" className={secondaryButtonClass}>
          {t("protection.filter")}
        </button>
      </form>
      <ProfileViewList
        items={log.items}
        showPerson
        emptyText={t("protection.logEmpty")}
        testId="club-profile-views"
      />
      {log.nextCursor ? (
        <a href={`/clubs/${club.id}/profile-views?${next.toString()}`} className="underline">
          {t("protection.showMore")}
        </a>
      ) : null}
    </div>
  );
}
