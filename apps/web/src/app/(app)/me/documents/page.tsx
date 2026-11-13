// SPDX-License-Identifier: AGPL-3.0-only
// "Mina dokument" (P2.2, ADR 0049 decision 9): the newest files of the
// viewer's (and their children's) groups and clubs, new ones marked (since
// they last opened the club's or group's documents).
import { EmptyState, formatDateTime } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { downloadHref, formatSize } from "../../../../components/documents.tsx";
import { getMyDocuments } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("documents.mine") };
}

export default async function MyDocumentsPage({ searchParams }: Props) {
  const query = await searchParams;
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, locale, timeZone, page] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getMyDocuments(cursor),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("documents.mine")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("documents.mineIntro")}</p>
      </div>
      {page.items.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="my-documents">
          {page.items.map((item) => {
            const d = item.document;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <a href={`/clubs/${d.clubId}/documents/${d.id}`} className="font-medium underline">
                  {d.name}
                </a>
                {item.isNew ? (
                  <span
                    className="rounded bg-accent px-1.5 py-0.5 text-xs text-accent-fg"
                    data-testid="new"
                  >
                    {t("documents.new")}
                  </span>
                ) : null}
                <span className="text-sm text-muted">
                  {item.groupName ?? item.clubName}
                  {d.publishedAt
                    ? ` · ${formatDateTime(d.publishedAt, { locale, timeZone, dateStyle: "medium" })}`
                    : ""}
                  {d.current ? ` · ${formatSize(d.current.size, locale)}` : ""}
                </span>
                {d.current ? (
                  <a href={downloadHref(d.clubId, d.id)} className="ml-auto text-sm underline">
                    {t("documents.download")}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title={t("documents.mineEmpty")} />
      )}
      {page.nextCursor ? (
        <a href={`/me/documents?cursor=${page.nextCursor}`} className="text-sm underline">
          {t("documents.more")}
        </a>
      ) : null}
    </div>
  );
}
