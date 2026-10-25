// SPDX-License-Identifier: AGPL-3.0-only
// The club's events (P1.6): those the viewer may see, open for sign-up
// first; "New event" for those who may create one.
import { getTranslations } from "next-intl/server";

import { secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { EventList } from "../../../../../components/event-list.tsx";
import { Notice } from "../../../../../components/form-error.tsx";
import { getClub, getClubEvents, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("events.title") };
}

export default async function ClubEventsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, events, mine] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubEvents(clubId, new Date().toISOString()),
    getMyClubs(),
  ]);
  const canCreate =
    mine.clubs.find((c) => c.club.id === club.id)?.permissions.includes("club.events.create") ??
    false;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}`} className="underline">
          {club.name}
        </a>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("events.title")}</h1>
        {canCreate ? (
          <a
            href={`/clubs/${club.id}/events/new`}
            className={secondaryButtonClass}
            data-testid="new-event"
          >
            {t("events.newTitle")}
          </a>
        ) : null}
      </div>
      {query.deleted ? <Notice>{t("events.deleted")}</Notice> : null}
      <EventList events={events.items} testId="club-events" />
    </div>
  );
}
