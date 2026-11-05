// SPDX-License-Identifier: AGPL-3.0-only
// The club's audit log (P1.9, club managers with a second factor): who did
// what, when, as composed sentences ("Sara Ahmed exported the member
// register"), with field names but never values, filtered by category,
// person acting and period; "Show older" pages by cursor.
import { AUDIT_CATEGORIES, type AuditItem, auditSentenceKey, auditVerbOf } from "@clubadmin/shared";
import { EmptyState } from "@clubadmin/ui";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";

import {
  actorOf,
  HistoryFilters,
  periodOf,
  stringOf,
} from "../../../../../components/history-filters.tsx";
import {
  ActorText,
  formatDateTime,
  HistoryError,
  type HistoryFormat,
  recordHref,
  RefText,
  translator,
} from "../../../../../components/history-list.tsx";
import { cursorOf } from "../../../../../components/history-view.tsx";
import { getAuditEvents, getClub } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** A message with simple {placeholders} filled with elements (names with links). */
function fill(pattern: string, parts: Record<string, ReactNode>): ReactNode[] {
  return pattern.split(/(\{[a-z]+\})/).map((piece, i) => {
    const name = /^\{([a-z]+)\}$/.exec(piece)?.[1];
    return <span key={i}>{name && name in parts ? parts[name] : piece}</span>;
  });
}

function Sentence({ item, f }: { item: AuditItem; f: HistoryFormat }) {
  const actor = <ActorText actor={item.actor} onBehalfOf={item.onBehalfOf} f={f} />;
  const key = auditSentenceKey(item.action);
  const resourceKey = `history.resources.${item.resourceType}`;
  const resource = f.t.has(resourceKey) ? f.t(resourceKey) : item.resourceType;
  if ("own" in key && f.t.has(`audit.actions.${key.own}`)) {
    return <>{fill(String(f.t.raw(`audit.actions.${key.own}`)), { actor })}</>;
  }
  const verbKey = `audit.verbs.${"verb" in key ? key.verb : auditVerbOf(item.action)}`;
  const verb = f.t.has(verbKey) ? f.t(verbKey) : item.action;
  return <>{fill(String(f.t.raw("audit.sentence")), { actor, verb, resource })}</>;
}

export default async function AuditPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club] = await Promise.all([translator(), getLocale(), getClub(clubId)]);
  const category = stringOf(query.category);
  const actorId = actorOf(query);
  const { from, to } = periodOf(query);
  const api = new URLSearchParams();
  if ((AUDIT_CATEGORIES as readonly string[]).includes(category)) api.set("category", category);
  if (actorId) api.set("actorId", actorId);
  if (from) api.set("from", from);
  if (to) api.set("to", to);
  const cursor = cursorOf(query.cursor);
  if (cursor) api.set("cursor", cursor);
  const result = await getAuditEvents(club.id, api.toString());
  const f: HistoryFormat = { t, locale, timeZone: club.timeZone, clubId: club.id };
  const older = (next: string) => {
    const q = new URLSearchParams(
      Object.fromEntries(
        ["category", "actorId", "actorQ", "from", "to"].flatMap((k) =>
          stringOf(query[k]) ? [[k, stringOf(query[k])]] : [],
        ),
      ),
    );
    q.set("cursor", next);
    return `/clubs/${club.id}/audit?${q}`;
  };
  let body: ReactNode;
  if (!result.page) body = <HistoryError code={result.error} />;
  else if (result.page.items.length === 0) body = <EmptyState title={t("audit.empty")} />;
  else
    body = (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="audit-table">
          <thead className="text-muted">
            <tr>
              <th className="py-2 pr-4">{t("audit.when")}</th>
              <th className="py-2 pr-4">{t("audit.what")}</th>
              <th className="py-2 pr-4">{t("audit.fields")}</th>
            </tr>
          </thead>
          <tbody>
            {result.page.items.map((item) => {
              const href = recordHref(item.link, club.id);
              return (
                <tr
                  key={item.id}
                  className="border-t border-border align-top"
                  data-testid="audit-entry"
                  data-action={item.action}
                >
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {formatDateTime(f, item.createdAt)}
                  </td>
                  <td className="py-2 pr-4">
                    <Sentence item={item} f={f} />
                    {item.about ? (
                      <>
                        {" · "}
                        <RefText value={item.about} f={f} />
                      </>
                    ) : null}
                    {href ? (
                      <>
                        {" · "}
                        <a href={href} className="text-accent underline">
                          {t("history.open")}
                        </a>
                      </>
                    ) : null}
                    <div className="text-xs text-muted">
                      {t(`audit.categories.${item.category}`)}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    {item.changedFields
                      .map((c) => (c.labelKey && t.has(c.labelKey) ? t(c.labelKey) : c.name))
                      .join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="space-y-6" data-testid="audit-page">
      <div>
        <a href={`/clubs/${club.id}`} className="text-sm text-accent underline">
          ← {club.name}
        </a>
        <h1 className="mt-2 text-2xl font-semibold">{t("audit.title")}</h1>
        <p className="text-muted">{t("audit.intro")}</p>
      </div>
      <HistoryFilters
        clubId={club.id}
        query={query}
        select={{
          name: "category",
          label: t("audit.category"),
          options: AUDIT_CATEGORIES.map((c) => ({ value: c, label: t(`audit.categories.${c}`) })),
        }}
      />
      {body}
      {result.page?.nextCursor ? (
        <a
          href={older(result.page.nextCursor)}
          className="inline-block text-sm text-accent underline"
        >
          {t("history.showOlder")}
        </a>
      ) : null}
      {result.page ? (
        <p className="text-sm text-muted">
          {t("audit.retention", { months: result.page.retentionMonths })}
        </p>
      ) : null}
    </div>
  );
}
