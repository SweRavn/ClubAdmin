// SPDX-License-Identifier: AGPL-3.0-only
// A safeguarding case (P2.1 part B, ADR 0047 rules 7 and 11): why it was
// reported and by whom (only the safeguarding officers see it), the
// requests to read the chat (two-person rule: one asks, another confirms),
// the chat itself while a confirmed read lasts (every load is a logged
// read; hidden texts are shown as the record), hiding a message, muting
// the reported person and closing the case with its outcome.
import { enumKey } from "@clubadmin/i18n";
import { CHAT_MUTE_MAX_HOURS, CHAT_REPORT_OUTCOMES } from "@clubadmin/shared";
import { formatDateTime, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { chatLabels, chatPersonLabel } from "../../../../../../components/chat-parts.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import { HistoryError } from "../../../../../../components/history-list.tsx";
import {
  getClub,
  getSafeguardingMessages,
  getSafeguardingReport,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; reportId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("safeguarding.case") };
}

export default async function SafeguardingCasePage({ params, searchParams }: Props) {
  const [{ clubId, reportId }, query] = await Promise.all([params, searchParams]);
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, labels, locale, timeZone, club, found] = await Promise.all([
    getTranslations(),
    chatLabels(),
    getLocale(),
    getTimeZone(),
    getClub(clubId),
    getSafeguardingReport(clubId, reportId),
  ]);
  const when = (iso: string) =>
    formatDateTime(iso, { locale, timeZone, dateStyle: "short", timeStyle: "short" });
  if (!found.page) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{t("safeguarding.case")}</h1>
        <HistoryError code={found.error ?? "error"} />
      </div>
    );
  }
  const d = found.page;
  const r = d.report;
  // Each load of the chat is a logged read: only when the caller may read.
  const messages = d.canRead ? await getSafeguardingMessages(clubId, reportId, cursor) : null;
  const back = `/clubs/${club.id}/safeguarding/${reportId}`;
  const ids = (
    <>
      <input type="hidden" name="clubId" value={club.id} />
      <input type="hidden" name="reportId" value={reportId} />
    </>
  );
  const name = (p: Parameters<typeof chatPersonLabel>[1]) => chatPersonLabel(labels, p);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}/safeguarding`} className="underline">
            {t("safeguarding.title")}
          </a>
        </p>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {t(enumKey("chat.reportReasons", r.reason))}
          <RoleBadge label={t(enumKey("safeguarding.statuses", r.status))} />
          {r.hasChildren ? <RoleBadge label={t("safeguarding.children")} /> : null}
        </h1>
      </div>
      <FormError code={query.error} />
      <dl className="grid max-w-prose grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{t("safeguarding.chat")}</dt>
        <dd>{r.chatKind === "direct" ? t("safeguarding.directChat") : (r.chatName ?? "")}</dd>
        <dt className="text-muted">{t("safeguarding.reportedPerson")}</dt>
        <dd>{r.reportedPerson ? name(r.reportedPerson) : t("safeguarding.wholeChat")}</dd>
        <dt className="text-muted">{t("safeguarding.reporter")}</dt>
        <dd data-testid="safeguarding-reporter">{name(d.reporter)}</dd>
        <dt className="text-muted">{t("safeguarding.reportedAt")}</dt>
        <dd>{when(r.createdAt)}</dd>
        {d.note ? (
          <>
            <dt className="text-muted">{t("safeguarding.note")}</dt>
            <dd className="whitespace-pre-wrap">{d.note}</dd>
          </>
        ) : null}
      </dl>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("safeguarding.reads")}</h2>
        <ul className="space-y-1 text-sm" data-testid="safeguarding-reads">
          {d.reads.map((x) => (
            <li key={x.id}>
              {x.status === "confirmed"
                ? t("safeguarding.confirmed", {
                    name: name(x.requestedBy),
                    other: name(x.confirmedBy),
                    time: when(x.expiresAt!),
                  })
                : x.status === "requested"
                  ? t("safeguarding.requested", {
                      name: name(x.requestedBy),
                      time: when(x.requestedAt),
                    })
                  : t("safeguarding.lapsed", {
                      name: name(x.requestedBy),
                      time: when(x.requestedAt),
                    })}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {d.canConfirm ? (
            <ActionForm action="safeguarding-confirm-read" back={back}>
              {ids}
              <input type="hidden" name="readId" value={d.canConfirm} />
              <button type="submit" className={buttonClass} data-testid="safeguarding-confirm">
                {t("safeguarding.confirm")}
              </button>
            </ActionForm>
          ) : null}
          {!d.canRead ? (
            <ActionForm action="safeguarding-request-read" back={back}>
              {ids}
              <button
                type="submit"
                className={secondaryButtonClass}
                data-testid="safeguarding-request"
              >
                {t("safeguarding.requestRead")}
              </button>
            </ActionForm>
          ) : null}
        </div>
      </section>

      {messages ? (
        <section className="space-y-2" data-testid="safeguarding-chat">
          <h2 className="text-lg font-semibold">{t("safeguarding.messages")}</h2>
          <p className="text-sm text-muted">{t("safeguarding.logged")}</p>
          {messages.error ? <HistoryError code={messages.error} /> : null}
          <ol className="space-y-2">
            {[...(messages.page?.items ?? [])].reverse().map((m) => (
              <li
                key={m.id}
                className={`rounded-md border px-3 py-2 text-sm ${
                  m.id === d.messageId ? "border-danger" : "border-border"
                }`}
              >
                <p className="text-xs text-muted">
                  {m.kind === "system" ? "" : name(m.sender)} · {when(m.createdAt)}
                  {m.id === d.messageId ? ` · ${t("safeguarding.reportedMessage")}` : ""}
                </p>
                {m.hidden ? (
                  <p className="italic text-muted">
                    {t("safeguarding.hiddenRecord")} {m.recordBody}
                  </p>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                )}
                {m.kind === "text" && m.hidden !== "moderator" ? (
                  <ActionForm action="safeguarding-hide" back={back} className="mt-1">
                    {ids}
                    <input type="hidden" name="messageId" value={m.id} />
                    <button type="submit" className="text-xs underline">
                      {t("safeguarding.hide")}
                    </button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ol>
          {messages.page?.nextCursor ? (
            <a href={`${back}?cursor=${messages.page.nextCursor}`} className="underline">
              {t("safeguarding.olderMessages")}
            </a>
          ) : null}
        </section>
      ) : null}

      {r.reportedPerson?.kind === "person" ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("safeguarding.mute")}</h2>
          <ActionForm
            action="safeguarding-mute"
            back={back}
            className="flex flex-wrap items-end gap-2"
          >
            {ids}
            <input type="hidden" name="personId" value={r.reportedPerson.person.id} />
            <label className="text-sm">
              <span className="block">{t("safeguarding.muteHours")}</span>
              <input
                type="number"
                name="hours"
                min={1}
                max={CHAT_MUTE_MAX_HOURS}
                defaultValue={24}
                className="w-24 rounded border border-border bg-bg px-2 py-1"
              />
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("safeguarding.mute")}
            </button>
          </ActionForm>
        </section>
      ) : null}

      {r.status === "open" ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("safeguarding.close")}</h2>
          <ActionForm action="safeguarding-close" back={back} className="space-y-2">
            {ids}
            <label className="block text-sm">
              <span className="block">{t("safeguarding.outcome")}</span>
              <select name="outcome" className="rounded border border-border bg-bg px-2 py-1">
                {CHAT_REPORT_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {t(enumKey("safeguarding.outcomes", o))}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="block">{t("safeguarding.outcomeNote")}</span>
              <textarea
                name="note"
                maxLength={1000}
                rows={3}
                className="w-full max-w-prose rounded border border-border bg-bg px-2 py-1"
              />
            </label>
            <button type="submit" className={buttonClass} data-testid="safeguarding-close">
              {t("safeguarding.close")}
            </button>
          </ActionForm>
        </section>
      ) : (
        <p className="text-sm text-muted">
          {r.outcome ? t(enumKey("safeguarding.outcomes", r.outcome)) : null}
          {r.closedAt
            ? ` · ${t("safeguarding.closedBy", { name: name(d.closedBy), time: when(r.closedAt) })}`
            : null}
          {d.outcomeNote ? (
            <span className="mt-1 block whitespace-pre-wrap">{d.outcomeNote}</span>
          ) : null}
        </p>
      )}
    </div>
  );
}
