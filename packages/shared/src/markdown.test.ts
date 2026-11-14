// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { markdownToPlain, parseInline, parseMarkdown, safeHref } from "./markdown.ts";

describe("markdown", () => {
  it("splits paragraphs and keeps line breaks", () => {
    expect(parseMarkdown("Hej!\nVi ses.\n\nAndra stycket")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Hej!" },
          { type: "break" },
          { type: "text", text: "Vi ses." },
        ],
      },
      { type: "paragraph", children: [{ type: "text", text: "Andra stycket" }] },
    ]);
  });

  it("parses bullet and numbered lists", () => {
    expect(parseMarkdown("- ett\n- två\n\n1. först\n2. sedan")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "ett" }], [{ type: "text", text: "två" }]],
      },
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "först" }], [{ type: "text", text: "sedan" }]],
      },
    ]);
  });

  it("parses strong, emphasis and safe links", () => {
    expect(parseInline("**Viktigt** och *lite* [läs](https://example.org/a)")).toEqual([
      { type: "strong", children: [{ type: "text", text: "Viktigt" }] },
      { type: "text", text: " och " },
      { type: "em", children: [{ type: "text", text: "lite" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://example.org/a", children: [{ type: "text", text: "läs" }] },
    ]);
  });

  it("never links javascript:, http: or data: and never renders HTML", () => {
    expect(parseInline("[x](javascript:alert(1))")[0]).toEqual({ type: "text", text: "x" });
    expect(safeHref("http://example.org")).toBeNull();
    expect(safeHref("data:text/html,<b>")).toBeNull();
    expect(safeHref("mailto:kansli@example.org")).toBe("mailto:kansli@example.org");
    expect(parseInline("<script>alert(1)</script>")).toEqual([
      { type: "text", text: "<script>alert(1)</script>" },
    ]);
  });

  it("links bare https addresses without trailing punctuation", () => {
    expect(parseInline("Se https://example.org/x.")).toEqual([
      { type: "text", text: "Se " },
      {
        type: "link",
        href: "https://example.org/x",
        children: [{ type: "text", text: "https://example.org/x" }],
      },
      { type: "text", text: "." },
    ]);
  });

  it("gives plain text for previews", () => {
    expect(markdownToPlain("**Årsmöte** 12 mars\n\n- kaffe\n- kaka")).toBe(
      "Årsmöte 12 mars kaffe · kaka",
    );
  });
});
