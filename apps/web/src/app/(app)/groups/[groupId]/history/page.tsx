// SPDX-License-Identifier: AGPL-3.0-only
// A group's history (P1.9): club managers and registrars.
import { cursorOf, HistoryView } from "../../../../../components/history-view.tsx";
import { getClub, getGroup } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function GroupHistoryPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const group = await getGroup(groupId);
  const club = await getClub(group.clubId);
  return (
    <HistoryView
      title={group.name}
      back={{ href: `/groups/${group.id}`, label: group.name }}
      apiPath={`groups/${group.id}`}
      pagePath={`/groups/${group.id}/history`}
      cursor={cursorOf(query.cursor)}
      clubId={group.clubId}
      timeZone={club.timeZone}
    />
  );
}
