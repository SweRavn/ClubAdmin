// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  markdownToPlain,
  parseInline,
  parseMarkdown,
  safeHref,
  settingMarkers,
} from "./markdown.ts";
import { settingMarkerValue } from "./privacy/club-settings.ts";

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

  it("parses headings of three levels (P2.4); more hashes stay text", () => {
    expect(parseMarkdown("# Stadgar\n## § 1 Ändamål\n\n#### fyra")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Stadgar" }] },
      { type: "heading", level: 2, children: [{ type: "text", text: "§ 1 Ändamål" }] },
      { type: "paragraph", children: [{ type: "text", text: "#### fyra" }] },
    ]);
  });

  it("keeps underscores inside words as text", () => {
    expect(parseInline("snake_case_name och _betoning_")).toEqual([
      { type: "text", text: "snake_case_name och " },
      { type: "em", children: [{ type: "text", text: "betoning" }] },
    ]);
  });

  it("reads settings markers only when asked (governing documents)", () => {
    const text = "Sparas i {{setting former_member_retention_months = 36}} månader.";
    expect(parseInline(text)).toEqual([{ type: "text", text }]);
    expect(parseInline(text, { settings: true })).toEqual([
      { type: "text", text: "Sparas i " },
      { type: "setting", key: "former_member_retention_months", value: "36" },
      { type: "text", text: " månader." },
    ]);
    expect(markdownToPlain(text, { settings: true })).toBe("Sparas i 36 månader.");
    expect(
      settingMarkers(
        "# §9\n- **{{setting consent_purposes = photos, newsletter}}**\n\n{{setting consent_reconfirm_on_new_version=ja}}",
      ),
    ).toEqual([
      { key: "consent_purposes", value: "photos, newsletter" },
      { key: "consent_reconfirm_on_new_version", value: "ja" },
    ]);
  });

  it("reads a marker's value for its setting's type", () => {
    expect(settingMarkerValue("former_member_retention_months", " 36 ")).toBe(36);
    expect(settingMarkerValue("former_member_retention_months", "tre")).toBeUndefined();
    expect(settingMarkerValue("consent_reconfirm_on_new_version", "Ja")).toBe(true);
    expect(settingMarkerValue("consent_reconfirm_on_new_version", "nei")).toBe(false);
    expect(settingMarkerValue("consent_reconfirm_on_new_version", "kanske")).toBeUndefined();
    expect(settingMarkerValue("consent_purposes", "photos, newsletter")).toEqual([
      "photos",
      "newsletter",
    ]);
    expect(settingMarkerValue("privacy_contact_email", "")).toBeNull();
  });
});
