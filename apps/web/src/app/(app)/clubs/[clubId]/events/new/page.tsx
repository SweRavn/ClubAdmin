// SPDX-License-Identifier: AGPL-3.0-only
// A new event (P1.6): for groups the viewer manages (all of them; the API
// checks), or the whole club (club managers and the board), with sessions
// created in its groups. Works without client JavaScript.
import { enumKey } from "@clubadmin/i18n";
import { ACTIVITY_KINDS, isUuid } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../../components/action-form.tsx";
import { EventFields } from "../../../../../../components/event-fields.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import { getClub, getClubGroups, getLocations } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("events.newTitle") };
}

export default async function NewEventPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const preselected =
    typeof query.groupId === "string" && isUuid(query.groupId) ? query.groupId : null;
  const [t, club, groups, locations] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubGroups(clubId),
    getLocations(clubId),
  ]);
  const active = groups.filter((g) => !g.archived);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}/events`} className="underline">
          {t("events.title")}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("events.newTitle")}</h1>
      <FormError code={query.error} />
      <ActionForm action="create-event" className="space-y-6" testId="new-event-form">
        <input type="hidden" name="clubId" value={club.id} />
        <fieldset className="space-y-2">
          <legend className="text-lg font-semibold">{t("events.audience")}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="audience" value="groups" defaultChecked />
            {t("events.audienceGroups")}
          </label>
          <div className="grid gap-1 pl-6 sm:grid-cols-3">
            {active.map((g) => (
              <label key={g.id} className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  name="groupId"
                  value={g.id}
                  defaultChecked={g.id === preselected}
                  data-testid="event-group"
                />
                {g.name}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input type="radio" name="audience" value="club" data-testid="event-audience-club" />
            {t("events.audienceClub")}
          </label>
        </fieldset>
        <EventFields timeZone={club.timeZone} locations={locations} emptyRows={3} />
        <fieldset className="space-y-3">
          <legend className="text-lg font-semibold">{t("events.sessions")}</legend>
          <p className="text-sm text-muted">{t("events.sessionsHint")}</p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-5">
              <select name={`a.${i}.kind`} className={inputClass} defaultValue="match">
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(enumKey("activityKinds", k))}
                  </option>
                ))}
              </select>
              <input
                name={`a.${i}.title`}
                className={inputClass}
                placeholder={t("activities.titleField")}
                aria-label={t("activities.titleField")}
                maxLength={120}
              />
              <input
                name={`a.${i}.date`}
                type="date"
                className={inputClass}
                aria-label={t("activities.date")}
              />
              <input
                name={`a.${i}.startTime`}
                type="time"
                className={inputClass}
                aria-label={t("activities.startTime")}
              />
              <input
                name={`a.${i}.endTime`}
                type="time"
                className={inputClass}
                aria-label={t("activities.endTime")}
              />
            </div>
          ))}
        </fieldset>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="publish" data-testid="event-publish" />
          {t("events.publishNow")}
        </label>
        <button type="submit" className={buttonClass} data-testid="event-create">
          {t("events.create")}
        </button>
      </ActionForm>
    </div>
  );
}
