// SPDX-License-Identifier: AGPL-3.0-only
// The shared Markdown subset (P2.3, ADR 0053) as web elements: the tree from
// @clubadmin/shared, never raw HTML. Links are https or mailto only (the
// parser checked them) and open in a new tab without a referrer.
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
    }
  });
}

export function Markdown({ source, testId }: { source: string; testId?: string }) {
  return (
    <div className="space-y-3 break-words" data-testid={testId}>
      {parseMarkdown(source).map((block, i) =>
        block.type === "paragraph" ? (
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
