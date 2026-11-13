// SPDX-License-Identifier: AGPL-3.0-only
// The club's safeguarding cases (P2.1 part B, ADR 0047 rules 7 and 11): the
// reports from its chats, open or closed, and who is muted now. For the
// safeguarding officers, with a second factor. A case's chat is read on the
// case page under the two-person rule.
import { enumKey } from "@clubadmin/i18n";
import { EmptyState, formatDateTime, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { chatLabels, chatPersonLabel } from "../../../../../components/chat-parts.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import { HistoryError } from "../../../../../components/history-list.tsx";
import {
  getClub,
  getSafeguardingMutes,
  getSafeguardingReports,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("safeguarding.title") };
}

export default async function SafeguardingPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const status = query.status === "closed" ? "closed" : "open";
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, labels, locale, timeZone, club, reports, mutes] = await Promise.all([
    getTranslations(),
    chatLabels(),
    getLocale(),
    getTimeZone(),
    getClub(clubId),
    getSafeguardingReports(clubId, status, cursor),
    getSafeguardingMutes(clubId),
  ]);
  const when = (iso: string) =>
    formatDateTime(iso, { locale, timeZone, dateStyle: "short", timeStyle: "short" });
  const back = `/clubs/${club.id}/safeguarding?status=${status}`;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("safeguarding.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("safeguarding.intro")}</p>
      </div>
      <FormError code={query.error} />
      <nav className="flex gap-4 text-sm" aria-label={t("safeguarding.title")}>
        {(["open", "closed"] as const).map((s) => (
          <a
            key={s}
            href={`/clubs/${club.id}/safeguarding?status=${s}`}
            aria-current={s === status ? "page" : undefined}
            className={s === status ? "font-semibold underline" : "underline"}
          >
            {t(`safeguarding.${s}`)}
          </a>
        ))}
      </nav>
      {reports.error ? (
        <HistoryError code={reports.error} />
      ) : reports.page && reports.page.items.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="safeguarding-reports">
          {reports.page.items.map((r) => (
            <li key={r.id}>
              <a
                href={`/clubs/${club.id}/safeguarding/${r.id}`}
                className="flex flex-wrap items-center gap-2 px-1 py-2 hover:bg-surface"
              >
                <span className="font-medium">{t(enumKey("chat.reportReasons", r.reason))}</span>
                {r.hasChildren ? <RoleBadge label={t("safeguarding.children")} /> : null}
                <span className="text-sm text-muted">
                  {r.chatKind === "direct" ? t("safeguarding.directChat") : (r.chatName ?? "")} ·{" "}
                  {r.reportedPerson
                    ? chatPersonLabel(labels, r.reportedPerson)
                    : t("safeguarding.wholeChat")}{" "}
                  · {when(r.createdAt)}
                </span>
                {r.outcome ? (
                  <RoleBadge label={t(enumKey("safeguarding.outcomes", r.outcome))} />
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("safeguarding.empty")} />
      )}
      {reports.page?.nextCursor ? (
        <a
          href={`/clubs/${club.id}/safeguarding?status=${status}&cursor=${reports.page.nextCursor}`}
          className="underline"
        >
          {t("safeguarding.olderMessages")}
        </a>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("safeguarding.mutes")}</h2>
        {mutes.page && mutes.page.items.length > 0 ? (
          <ul className="space-y-1 text-sm" data-testid="safeguarding-mutes">
            {mutes.page.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{chatPersonLabel(labels, m.person)}</span>
                <span className="text-muted">
                  {t("safeguarding.mutedUntil", { time: when(m.until) })} ·{" "}
                  {t("safeguarding.mutedBy", { name: chatPersonLabel(labels, m.mutedBy) })}
                </span>
                <ActionForm action="safeguarding-unmute" back={back}>
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="muteId" value={m.id} />
                  <button type="submit" className={secondaryButtonClass}>
                    {t("safeguarding.unmute")}
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        ) : mutes.error ? null : (
          <p className="text-sm text-muted">{t("safeguarding.noMutes")}</p>
        )}
      </section>
    </div>
  );
}
