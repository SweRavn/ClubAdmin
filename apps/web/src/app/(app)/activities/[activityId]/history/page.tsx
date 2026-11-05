// SPDX-License-Identifier: AGPL-3.0-only
// An activity's history: changes, answers and attendance (P1.9): club
// managers and registrars.
import { cursorOf, HistoryView } from "../../../../../components/history-view.tsx";
import { getActivity } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ activityId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ActivityHistoryPage({ params, searchParams }: Props) {
  const [{ activityId }, query] = await Promise.all([params, searchParams]);
  const activity = await getActivity(activityId);
  return (
    <HistoryView
      title={activity.title}
      back={{ href: `/activities/${activity.id}`, label: activity.title }}
      apiPath={`activities/${activity.id}`}
      pagePath={`/activities/${activity.id}/history`}
      cursor={cursorOf(query.cursor)}
      clubId={activity.clubId}
      timeZone={activity.timeZone}
    />
  );
}
