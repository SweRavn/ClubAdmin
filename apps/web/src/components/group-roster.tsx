// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A roster with more than one page: the first page comes from the server,
// further pages through the BFF with the generated API client and TanStack
// Query (keyset pagination). Rosters that fit on one page are rendered by the
// server alone, without this component's JavaScript. Texts come translated
// from the server.

import { createApiClient } from "@clubadmin/api-client";
import type { GroupMemberList } from "@clubadmin/shared";
import { DataList, type Page } from "@clubadmin/ui/data-list";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { RosterEntry, type RosterTexts } from "./roster-entry.tsx";

type Entry = GroupMemberList["items"][number];

export interface GroupRosterTexts extends RosterTexts {
  loadMore: string;
  loading: string;
  failed: string;
}

export function GroupRoster({
  groupId,
  clubId,
  initialPage,
  pageSize,
  texts,
}: {
  groupId: string;
  clubId: string;
  initialPage: Page<Entry>;
  pageSize: number;
  texts: GroupRosterTexts;
}) {
  const [queryClient] = useState(() => new QueryClient());
  // Created on first use: the component also renders on the server, without `window`.
  const api = useMemo(() => {
    let client: ReturnType<typeof createApiClient> | undefined;
    return () => (client ??= createApiClient({ baseUrl: window.location.origin }));
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <DataList<Entry>
        testId="group-members"
        queryKey={["groups", groupId, "members"]}
        initialPage={initialPage}
        fetchPage={async (cursor) => {
          const { data } = await api().GET("/api/v1/groups/{groupId}/members", {
            params: { path: { groupId }, query: { cursor, limit: pageSize } },
          });
          return data!;
        }}
        getKey={(entry) => entry.person.id}
        renderItem={(entry) => <RosterEntry entry={entry} clubId={clubId} texts={texts} />}
        labels={{ loadMore: texts.loadMore, loading: texts.loading, failed: texts.failed }}
      />
    </QueryClientProvider>
  );
}
