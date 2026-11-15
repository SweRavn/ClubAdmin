// SPDX-License-Identifier: AGPL-3.0-only
// The annual (or an extra) meeting (an event for the club, P2.4): its
// agenda, minutes per item, decisions and action items, and the minutes
// assembled into the club's annual meeting minutes.
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { MeetingAgenda } from "../../../../../components/meetings.tsx";
import {
  getAdultMembersIfAllowed,
  getAgenda,
  getAgendaTemplates,
  getDocumentSeries,
  getEvent,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("meetings.agenda") };
}

export default async function EventAgendaPage({ params, searchParams }: Props) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const [event, agenda] = await Promise.all([getEvent(eventId), getAgenda("events", eventId)]);
  if (!agenda) notFound();
  const [members, templates, series] = agenda.canEdit
    ? await Promise.all([
        getAdultMembersIfAllowed(event.clubId),
        getAgendaTemplates(event.clubId),
        getDocumentSeries(event.clubId, null),
      ])
    : [null, null, null];
  return (
    <MeetingAgenda
      agenda={agenda}
      clubId={event.clubId}
      people={members?.items.map((m) => m.person) ?? []}
      templates={(templates?.items ?? []).filter((x) => x.meetingKind !== "board_meeting")}
      series={(series?.items ?? [])
        .filter((s) => s.seriesKind === "annual_meeting_minutes" || s.seriesKind === "other")
        .map((s) => ({ id: s.id, name: s.name }))}
      query={query}
    />
  );
}
