// SPDX-License-Identifier: AGPL-3.0-only
// A board's or committee's meeting (an activity of kind `meeting`, P2.4):
// its agenda, minutes per item, decisions and action items, and the minutes
// assembled into the group's (or the club's) series.
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { MeetingAgenda } from "../../../../../components/meetings.tsx";
import {
  getActivity,
  getAgenda,
  getAgendaTemplates,
  getDocumentSeries,
  getGroupMembers,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ activityId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("meetings.agenda") };
}

export default async function ActivityAgendaPage({ params, searchParams }: Props) {
  const [{ activityId }, query] = await Promise.all([params, searchParams]);
  const [activity, agenda] = await Promise.all([
    getActivity(activityId),
    getAgenda("activities", activityId),
  ]);
  if (!agenda) notFound();
  const groupId = activity.groups[0]?.id ?? null;
  const [members, templates, groupSeries, clubSeries] = agenda.canEdit
    ? await Promise.all([
        groupId ? getGroupMembers(groupId, 200) : Promise.resolve(null),
        getAgendaTemplates(activity.clubId),
        groupId ? getDocumentSeries(activity.clubId, groupId) : Promise.resolve(null),
        getDocumentSeries(activity.clubId, null),
      ])
    : [null, null, null, null];
  return (
    <MeetingAgenda
      agenda={agenda}
      clubId={activity.clubId}
      people={members?.items.map((m) => m.person) ?? []}
      templates={(templates?.items ?? []).filter(
        (x) => x.meetingKind === "board_meeting" || x.meetingKind === "other",
      )}
      series={[...(groupSeries?.items ?? []), ...(clubSeries?.items ?? [])]
        .filter((s) => s.seriesKind === "board_minutes" || s.seriesKind === "other")
        .map((s) => ({ id: s.id, name: s.name }))}
      query={query}
    />
  );
}
