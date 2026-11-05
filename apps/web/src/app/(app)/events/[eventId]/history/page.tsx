// SPDX-License-Identifier: AGPL-3.0-only
// An event's history: changes and registrations (P1.9): club managers and
// registrars. Sensitive answers never appear.
import { cursorOf, HistoryView } from "../../../../../components/history-view.tsx";
import { getEvent } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function EventHistoryPage({ params, searchParams }: Props) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const event = await getEvent(eventId);
  return (
    <HistoryView
      title={event.title}
      back={{ href: `/events/${event.id}`, label: event.title }}
      apiPath={`events/${event.id}`}
      pagePath={`/events/${event.id}/history`}
      cursor={cursorOf(query.cursor)}
      clubId={event.clubId}
      timeZone={event.timeZone}
    />
  );
}
