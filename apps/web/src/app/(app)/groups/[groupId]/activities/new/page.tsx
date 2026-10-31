// SPDX-License-Identifier: AGPL-3.0-only
// A new match, meeting or other single activity of a group (P1.4); with
// other groups ticked, a joint activity (the API checks that the viewer
// manages each). Works without client JavaScript.
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../../components/action-form.tsx";
import { ActivityFields } from "../../../../../../components/activity-fields.tsx";
import { weekRange } from "../../../../../../components/agenda.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import {
  getClub,
  getClubGroups,
  getGroup,
  getGroupCalendar,
  getLocations,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("activities.newTitle") };
}

export default async function NewActivityPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const { from, to } = weekRange(0, 1);
  const [t, group, calendar] = await Promise.all([
    getTranslations(),
    getGroup(groupId),
    getGroupCalendar(groupId, from, to),
  ]);
  if (!calendar.canManage) forbidden();
  const [club, groups, locations] = await Promise.all([
    getClub(group.clubId),
    getClubGroups(group.clubId),
    getLocations(group.clubId),
  ]);
  const others = groups.filter((g) => g.id !== group.id && !g.archived);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/groups/${group.id}`} className="underline">
          {group.name}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("activities.newTitle")}</h1>
      <FormError code={query.error} />
      <ActionForm action="create-activity" className="space-y-4" testId="new-activity-form">
        <input type="hidden" name="groupId" value={group.id} />
        <ActivityFields
          timeZone={club.timeZone}
          locations={locations}
          addPlaceHref={`/clubs/${club.id}/locations#new-location`}
        />
        {others.length > 0 ? (
          <fieldset className="space-y-1">
            <legend className="text-sm">{t("activities.jointGroups")}</legend>
            <p className="text-xs text-muted">{t("activities.jointHint")}</p>
            <div className="grid gap-1 sm:grid-cols-3">
              {others.map((g) => (
                <label key={g.id} className="inline-flex items-center gap-2">
                  <input type="checkbox" name="otherGroupId" value={g.id} />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <button type="submit" className={buttonClass} data-testid="activity-create">
          {t("activities.create")}
        </button>
      </ActionForm>
    </div>
  );
}
