// SPDX-License-Identifier: AGPL-3.0-only
// An activity series' history (P1.9): club managers and registrars.
import { cursorOf, HistoryView } from "../../../../../components/history-view.tsx";
import { getClub, getSeries } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ seriesId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SeriesHistoryPage({ params, searchParams }: Props) {
  const [{ seriesId }, query] = await Promise.all([params, searchParams]);
  const series = await getSeries(seriesId);
  const club = await getClub(series.clubId);
  return (
    <HistoryView
      title={series.title}
      back={{ href: `/activity-series/${series.id}`, label: series.title }}
      apiPath={`activity-series/${series.id}`}
      pagePath={`/activity-series/${series.id}/history`}
      cursor={cursorOf(query.cursor)}
      clubId={series.clubId}
      timeZone={club.timeZone}
    />
  );
}
