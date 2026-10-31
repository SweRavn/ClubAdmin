// SPDX-License-Identifier: AGPL-3.0-only
// A new event (P1.6): for groups the viewer manages (all of them; the API
// checks), or the whole club (club managers and the board), with sessions
// created in its groups. Works without client JavaScript; published by
// default (P1.6b), a failed save keeps what was typed.
import { isUuid } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../../components/action-form.tsx";
import { EventFields, EventSessions } from "../../../../../../components/event-fields.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import { formDraft, getClub, getClubGroups, getLocations } from "../../../../../../server/data.ts";

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
  const [t, club, groups, locations, draft] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubGroups(clubId),
    getLocations(clubId),
    formDraft("create-event", query),
  ]);
  const active = groups.filter((g) => !g.archived);
  const chosen = new Set(draft ? (draft.get("groupId") ?? []) : preselected ? [preselected] : []);
  const clubAudience = draft?.get("audience")?.[0] === "club";

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
            <input type="radio" name="audience" value="groups" defaultChecked={!clubAudience} />
            {t("events.audienceGroups")}
          </label>
          <div className="grid gap-1 pl-6 sm:grid-cols-3">
            {active.map((g) => (
              <label key={g.id} className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  name="groupId"
                  value={g.id}
                  defaultChecked={chosen.has(g.id)}
                  data-testid="event-group"
                />
                {g.name}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="audience"
              value="club"
              defaultChecked={clubAudience}
              data-testid="event-audience-club"
            />
            {t("events.audienceClub")}
          </label>
        </fieldset>
        <EventFields
          timeZone={club.timeZone}
          locations={locations}
          draft={draft}
          questionRows={query.qrows}
          error={query.error}
        />
        <EventSessions draft={draft} sessionRows={query.srows} />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="publish"
            defaultChecked={draft ? draft.get("publish")?.[0] === "on" : true}
            data-testid="event-publish"
          />
          {t("events.publishNow")}
        </label>
        <button type="submit" className={buttonClass} data-testid="event-create">
          {t("events.create")}
        </button>
      </ActionForm>
    </div>
  );
}
