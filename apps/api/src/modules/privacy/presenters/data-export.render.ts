// SPDX-License-Identifier: AGPL-3.0-only
// The "download my data" file in two forms (P1.8b, docs/api/data-export.md):
// data.json (the versioned, machine-readable schema) and a self-contained
// index.html in the requester's language (no external resources, no
// scripts) with a README: who controls each part, what is left out and how
// to ask a club for more. Both are written part by part.

import type { Locale } from "@clubadmin/i18n";
import { message } from "@clubadmin/server-kit/notifications";

import type {
  ClubPart,
  ExportHeader,
  ExportRow,
  ExportSection,
  PlatformPart,
} from "./data-export.collect.ts";

export type Names = Record<string, { name: string; protected: boolean }>;

/** data.json, in pieces: open, one piece per part, close (with the names collected). */
export const jsonOpen = (header: ExportHeader): string =>
  `{${JSON.stringify(header).slice(1, -1)},"parts":[`;

export function jsonPart(part: PlatformPart | ClubPart, first: boolean): string {
  const sections = Object.fromEntries(part.sections.map((s) => [s.key, s.rows]));
  const body =
    part.kind === "platform"
      ? { controller: "platform", sections }
      : { controller: "club", clubId: part.clubId, clubName: part.clubName, sections };
  return `${first ? "" : ","}${JSON.stringify(body)}`;
}

export const jsonClose = (names: Names): string => `],"people":${JSON.stringify(names)}}`;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** Columns only for machines (IDs of things that have a title shown next to them). */
const HIDDEN_IN_HTML = /^(id|clubId|groupId|activityId|eventId|subjectId|preferredGroupIds)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export interface HtmlContext {
  locale: Locale;
  timeZone: string;
  names: Names;
}

function t(locale: Locale, key: string, values: Record<string, string> = {}): string {
  return message(locale, key, values);
}

function label(locale: Locale, key: string): string {
  return t(locale, `dataExport.fields.${key}`) || key;
}

function formatValue(ctx: HtmlContext, key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (/PersonIds?$|WardIds$/.test(key)) {
    const ids = Array.isArray(value) ? value : [value];
    return ids
      .map((id) =>
        typeof id === "string"
          ? escape(ctx.names[id]?.name ?? t(ctx.locale, "dataExport.hiddenPerson"))
          : "",
      )
      .join(", ");
  }
  if (typeof value === "boolean") {
    return escape(t(ctx.locale, value ? "dataExport.yes" : "dataExport.no"));
  }
  if (typeof value === "string" && ISO.test(value)) {
    return escape(
      new Intl.DateTimeFormat(ctx.locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: ctx.timeZone,
      }).format(new Date(value)),
    );
  }
  if (Array.isArray(value) && value.every((v) => typeof v !== "object")) {
    return escape(value.join(", "));
  }
  if (typeof value === "string") return escape(value);
  if (typeof value === "number" || typeof value === "bigint") return escape(value.toString());
  return `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;
}

function sectionHtml(ctx: HtmlContext, section: ExportSection): string {
  const title = escape(t(ctx.locale, `dataExport.sections.${section.key}`) || section.key);
  if (section.rows.length === 0) {
    return `<section><h3>${title}</h3><p class="empty">${escape(t(ctx.locale, "dataExport.empty"))}</p></section>`;
  }
  const columns = [
    ...new Set(section.rows.flatMap((r) => Object.keys(r).filter((k) => !HIDDEN_IN_HTML.test(k)))),
  ];
  const head = columns.map((c) => `<th>${escape(label(ctx.locale, c))}</th>`).join("");
  const body = section.rows
    .map(
      (row: ExportRow) =>
        `<tr>${columns.map((c) => `<td>${formatValue(ctx, c, row[c])}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<section><h3>${title}</h3><div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

const STYLE = `body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.6rem}h2{margin-top:2.5rem;border-bottom:1px solid #ccc}h3{font-size:1.05rem;margin-top:1.5rem}
table{border-collapse:collapse;font-size:.85rem}th,td{border:1px solid #ddd;padding:.3rem .5rem;text-align:left;vertical-align:top}
th{background:#f3f3f3}.scroll{overflow-x:auto}.empty{color:#666}pre{margin:0;white-space:pre-wrap}
.readme{background:#f7f7f7;padding:1rem;border-radius:.5rem}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}th{background:#222}th,td{border-color:#444}.readme{background:#1c1c1c}}`;

export function htmlOpen(locale: Locale, header: ExportHeader, subjectName: string): string {
  const title = escape(t(locale, "dataExport.title", { name: subjectName }));
  const readme = ["intro", "controllers", "notIncluded", "askClub", "formats"]
    .map((key) => `<p>${escape(t(locale, `dataExport.readme.${key}`))}</p>`)
    .join("");
  const generated = escape(
    t(locale, "dataExport.generated", {
      date: new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
        new Date(header.generatedAt),
      ),
    }),
  );
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><h1>${title}</h1><p>${generated}</p><section class="readme"><h2>${escape(t(locale, "dataExport.readme.title"))}</h2>${readme}</section>`;
}

export function htmlPart(ctx: HtmlContext, part: PlatformPart | ClubPart): string {
  const heading =
    part.kind === "platform" ? escape(t(ctx.locale, "dataExport.platform")) : escape(part.clubName);
  const controller =
    part.kind === "platform"
      ? t(ctx.locale, "dataExport.controller.platform")
      : t(ctx.locale, "dataExport.controller.club", { club: part.clubName });
  return `<h2>${heading}</h2><p>${escape(controller)}</p>${part.sections.map((s) => sectionHtml(ctx, s)).join("")}`;
}

export const htmlClose = (): string => "</body></html>";
