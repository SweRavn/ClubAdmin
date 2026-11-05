// SPDX-License-Identifier: AGPL-3.0-only
// A detail page's history (P1.9, ADR 0042) on a page of its own: read only
// when opened, so the detail pages make no history call. The cursor and
// the page's own query parameters stay in the URL ("Show older" is a link).

import { getTranslations } from "next-intl/server";

import { getHistory, getMyClubs } from "../server/data.ts";
import { HistoryError, HistoryList } from "./history-list.tsx";

export function cursorOf(value: string | string[] | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
}

export async function HistoryView({
  title,
  back,
  apiPath,
  pagePath,
  params = {},
  pageParams,
  cursor,
  clubId,
  timeZone,
  links = false,
}: {
  title: string;
  back: { href: string; label: string };
  /** The API resource, e.g. "groups/<id>" (IDs checked by the caller). */
  apiPath: string;
  /** This page, for "Show older". */
  pagePath: string;
  /** Query parameters for the API (clubId, filters). */
  params?: Record<string, string>;
  /** Query parameters of this page kept for "Show older" (default: params). */
  pageParams?: Record<string, string>;
  cursor: string | null;
  clubId: string;
  timeZone: string;
  links?: boolean;
}) {
  const t = await getTranslations();
  const query = new URLSearchParams(params);
  if (cursor) query.set("cursor", cursor);
  const result = await getHistory(apiPath, query.toString());
  const older = (next: string) => {
    const q = new URLSearchParams(pageParams ?? params);
    q.set("cursor", next);
    return `${pagePath}?${q}`;
  };
  return (
    <div className="space-y-6" data-testid="history-page">
      <div>
        <a href={back.href} className="text-sm text-accent underline">
          ← {back.label}
        </a>
        <h1 className="mt-2 text-2xl font-semibold">
          {t("history.title")} · {title}
        </h1>
      </div>
      {result.page ? (
        <HistoryList
          page={result.page}
          timeZone={timeZone}
          clubId={clubId}
          olderHref={older}
          links={links}
        />
      ) : (
        <HistoryError code={result.error} />
      )}
    </div>
  );
}

/** The link to a record's history page, for club managers and registrars of its club only. */
export async function HistoryLink({ clubId, href }: { clubId: string; href: string }) {
  const [t, mine] = await Promise.all([getTranslations(), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === clubId)?.permissions ?? [];
  if (!readsHistory(permissions)) return null;
  return (
    <a href={href} className="text-sm text-accent underline" data-testid="history-link">
      {t("history.show")}
    </a>
  );
}

/** Club managers and registrars read the history panels (the API checks; this is the hint). */
export const readsHistory = (permissions: readonly string[]) =>
  permissions.includes("club.members.manage");
