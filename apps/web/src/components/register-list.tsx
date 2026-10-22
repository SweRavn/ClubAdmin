// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The member register beyond its first page (P1.2): further pages through the
// BFF with the generated API client and TanStack Query (keyset pagination),
// virtualised above 200 rows (DataList). Loaded lazily, only for lists with
// more than one page (lazy-register-list.tsx).

import { createApiClient } from "@clubadmin/api-client";
import type { RegisterMember } from "@clubadmin/shared";
import { DataList, type Page } from "@clubadmin/ui/data-list";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { RegisterEntry, type RegisterTexts } from "./register-entry.tsx";

export interface RegisterListTexts extends RegisterTexts {
  loadMore: string;
  loading: string;
  failed: string;
  label: string;
}

export function RegisterList({
  clubId,
  query,
  initialPage,
  texts,
}: {
  clubId: string;
  /** The page's search and filters (validated query string). */
  query: string;
  initialPage: Page<RegisterMember>;
  texts: RegisterListTexts;
}) {
  const [queryClient] = useState(() => new QueryClient());
  const api = useMemo(() => {
    let client: ReturnType<typeof createApiClient> | undefined;
    return () => (client ??= createApiClient({ baseUrl: window.location.origin }));
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <DataList<RegisterMember>
        testId="register"
        label={texts.label}
        queryKey={["clubs", clubId, "members", query]}
        initialPage={initialPage}
        fetchPage={async (cursor) => {
          const params = Object.fromEntries(new URLSearchParams(query));
          const { data } = await api().GET("/api/v1/clubs/{clubId}/members", {
            params: { path: { clubId }, query: { ...params, cursor } as never },
          });
          return data!;
        }}
        getKey={(member) => member.person.id}
        renderItem={(member) => <RegisterEntry member={member} clubId={clubId} texts={texts} />}
        labels={{ loadMore: texts.loadMore, loading: texts.loading, failed: texts.failed }}
      />
    </QueryClientProvider>
  );
}
