// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// A keyset-paginated list (PageQuerySchema: cursor = the previous page's
// nextCursor). The first page comes from the server; "Show more" loads the
// next one with TanStack Query. Long lists are virtualised (only the rows on
// screen are in the DOM).

import { useInfiniteQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense } from "react";

import type { VirtualRows as VirtualRowsComponent } from "./virtual-rows.tsx";

// Only long lists need it: loaded when a list grows past virtualiseAbove.
const VirtualRows = lazy(() =>
  import("./virtual-rows.tsx").then((m) => ({ default: m.VirtualRows })),
) as unknown as typeof VirtualRowsComponent; // lazy() drops the generic

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DataListProps<T> {
  queryKey: readonly unknown[];
  initialPage: Page<T>;
  fetchPage: (cursor: string) => Promise<Page<T>>;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  labels: { loadMore: string; loading: string; failed: string };
  /** Accessible name of the list. */
  label?: string;
  /** Rows above this count are virtualised. */
  virtualiseAbove?: number;
  /** Estimated row height in pixels (virtualised lists). */
  rowHeight?: number;
  testId?: string;
}

export function DataList<T>({
  queryKey,
  initialPage,
  fetchPage,
  getKey,
  renderItem,
  labels,
  label,
  virtualiseAbove = 200,
  rowHeight = 44,
  testId,
}: DataListProps<T>) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => (pageParam ? fetchPage(pageParam) : Promise.resolve(initialPage)),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<T>) => last.nextCursor,
    initialData: { pages: [initialPage], pageParams: [null] },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const items = query.data.pages.flatMap((page) => page.items);

  return (
    <div data-testid={testId}>
      {items.length > virtualiseAbove ? (
        <Suspense fallback={<p role="status">{labels.loading}</p>}>
          <VirtualRows
            items={items}
            getKey={getKey}
            renderItem={renderItem}
            rowHeight={rowHeight}
            label={label}
          />
        </Suspense>
      ) : (
        <ul aria-label={label} className="divide-y divide-border">
          {items.map((item) => (
            <li key={getKey(item)} className="py-2">
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
          >
            {query.isFetchingNextPage ? labels.loading : labels.loadMore}
          </button>
        </div>
      ) : null}
      {query.isFetchNextPageError ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {labels.failed}
        </p>
      ) : null}
    </div>
  );
}
