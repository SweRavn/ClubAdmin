// SPDX-License-Identifier: AGPL-3.0-only
// The club's changes (P1.9, club managers with a second factor): every
// change to the club's records, newest first, each linked to its record's
// page. With a kind of record or a person the period is at most 90 days
// (the last 30 by default). ?scope=club is the club page's own history.
import { CLUB_HISTORY_RESOURCES } from "@clubadmin/shared";

import {
  actorOf,
  HistoryFilters,
  periodOf,
  stringOf,
} from "../../../../../components/history-filters.tsx";
import { translator } from "../../../../../components/history-list.tsx";
import { cursorOf, HistoryView } from "../../../../../components/history-view.tsx";
import { getClub } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DAY = 86_400_000;

export default async function ClubHistoryPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club] = await Promise.all([translator(), getClub(clubId)]);
  const scope = stringOf(query.scope) === "club";
  const table = stringOf(query.table);
  const actorId = actorOf(query);
  const kept: Record<string, string> = {};
  if (scope) kept.scope = "club";
  else {
    if ((CLUB_HISTORY_RESOURCES as readonly string[]).includes(table)) kept.table = table;
    if (actorId) kept.actorId = actorId;
    let { from, to } = periodOf(query);
    // A filter needs a period: the last 30 days unless one is chosen.
    if ((kept.table || kept.actorId) && !from && !to) {
      to = new Date().toISOString();
      from = new Date(Date.now() - 30 * DAY).toISOString();
    }
    if (from) kept.from = from;
    if (to) kept.to = to;
  }
  // This page's own parameters for "Show older" (the form's values).
  const pageParams = Object.fromEntries(
    ["scope", "table", "actorId", "actorQ", "from", "to"].flatMap((k) =>
      stringOf(query[k]) ? [[k, stringOf(query[k])]] : [],
    ),
  );
  return (
    <div className="space-y-6">
      {!scope ? (
        <>
          <p className="text-muted">{t("history.clubIntro")}</p>
          <HistoryFilters
            clubId={club.id}
            query={query}
            select={{
              name: "table",
              label: t("history.filterTable"),
              options: CLUB_HISTORY_RESOURCES.map((r) => ({
                value: r,
                label: t(`history.resources.${r}`),
              })),
            }}
          />
        </>
      ) : null}
      <HistoryView
        title={scope ? club.name : t("history.clubTitle")}
        back={{ href: `/clubs/${club.id}`, label: club.name }}
        apiPath={`clubs/${club.id}`}
        pagePath={`/clubs/${club.id}/history`}
        params={kept}
        pageParams={pageParams}
        cursor={cursorOf(query.cursor)}
        clubId={club.id}
        timeZone={club.timeZone}
        links
      />
    </div>
  );
}
