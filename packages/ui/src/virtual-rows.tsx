// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Window-virtualised rows for long lists (DataList): only the rows on screen
// are in the DOM.

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export function VirtualRows<T>({
  items,
  getKey,
  renderItem,
  rowHeight,
  label,
}: {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  rowHeight: number;
  label: string | undefined;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    setOffset(listRef.current?.offsetTop ?? 0);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => rowHeight,
    overscan: 10,
    scrollMargin: offset,
  });
  // Styles are set through the DOM (CSSOM), which the CSP allows.
  return (
    <ul
      ref={listRef}
      aria-label={label}
      aria-rowcount={items.length}
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => {
        const item = items[row.index]!;
        return (
          <li
            key={getKey(item)}
            data-index={row.index}
            ref={virtualizer.measureElement}
            aria-posinset={row.index + 1}
            aria-setsize={items.length}
            className="absolute inset-x-0 border-b border-border py-2"
            style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
          >
            {renderItem(item)}
          </li>
        );
      })}
    </ul>
  );
}
