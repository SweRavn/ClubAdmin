// SPDX-License-Identifier: AGPL-3.0-only
// A member's history in a club (P1.9): club managers and registrars.
import { isUuid } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { notFound } from "next/navigation";

import { cursorOf, HistoryView } from "../../../../../components/history-view.tsx";
import { getClub, getPerson, requireId } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function PersonHistoryPage({ params, searchParams }: Props) {
  const [{ personId }, query] = await Promise.all([params, searchParams]);
  const clubId = typeof query.clubId === "string" && isUuid(query.clubId) ? query.clubId : null;
  if (!clubId) notFound();
  const [profile, club] = await Promise.all([getPerson(personId, clubId), getClub(clubId)]);
  const back = `/people/${requireId(personId)}?clubId=${clubId}`;
  return (
    <HistoryView
      title={personLabel(profile.person)}
      back={{ href: back, label: personLabel(profile.person) }}
      apiPath={`people/${personId}`}
      pagePath={`/people/${personId}/history`}
      params={{ clubId }}
      cursor={cursorOf(query.cursor)}
      clubId={clubId}
      timeZone={club.timeZone}
    />
  );
}
