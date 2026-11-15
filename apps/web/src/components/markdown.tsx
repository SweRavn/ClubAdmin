// SPDX-License-Identifier: AGPL-3.0-only
// The shared Markdown subset (P2.3, ADR 0053) as web elements: the tree from
// @clubadmin/shared, never raw HTML. Links are https or mailto only (the
// parser checked them) and open in a new tab without a referrer. Headings
// and, for governing documents (`settings`), settings markers (P2.4): a
// marker shows its value, marked, with the setting's key for the editor.
import { type MarkdownInline, parseMarkdown } from "@clubadmin/shared";
import type { ReactNode } from "react";

function inline(nodes: readonly MarkdownInline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.type) {
      case "text":
        return n.text;
      case "break":
        return <br key={k} />;
      case "strong":
        return <strong key={k}>{inline(n.children, `${k}.`)}</strong>;
      case "em":
        return <em key={k}>{inline(n.children, `${k}.`)}</em>;
      case "link":
        return (
          <a key={k} href={n.href} className="underline" target="_blank" rel="noreferrer noopener">
            {inline(n.children, `${k}.`)}
          </a>
        );
      case "setting":
        return (
          <span
            key={k}
            className="rounded bg-accent-soft px-1 font-medium"
            data-setting={n.key}
            title={n.key}
          >
            {n.value}
          </span>
        );
    }
  });
}

const HEADING_CLASS = {
  1: "text-xl font-semibold",
  2: "text-lg font-semibold",
  3: "font-semibold",
};

export function Markdown({
  source,
  testId,
  settings = false,
}: {
  source: string;
  testId?: string;
  /** Show settings markers (governing documents). */
  settings?: boolean;
}) {
  return (
    <div className="space-y-3 break-words" data-testid={testId}>
      {parseMarkdown(source, { settings }).map((block, i) =>
        block.type === "heading" ? (
          block.level === 1 ? (
            <h2 key={i} className={HEADING_CLASS[1]}>
              {inline(block.children)}
            </h2>
          ) : block.level === 2 ? (
            <h3 key={i} className={HEADING_CLASS[2]}>
              {inline(block.children)}
            </h3>
          ) : (
            <h4 key={i} className={HEADING_CLASS[3]}>
              {inline(block.children)}
            </h4>
          )
        ) : block.type === "paragraph" ? (
          <p key={i}>{inline(block.children)}</p>
        ) : block.ordered ? (
          <ol key={i} className="list-decimal space-y-1 pl-6">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-6">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
