// SPDX-License-Identifier: AGPL-3.0-only
// My and my children's waiting lists (P1.10b, ADR 0043): offers first, with
// the deadline in the club's time zone and "Accept place" / "Decline"; then
// the places in the queue ("Number 2 of 5") with "Leave the waiting list";
// then entries closed in the last 12 months. The offer email links here.
// Server actions only, so it works without JavaScript; an offer that expired
// while the page was open shows the server's answer.
import { enumKey } from "@clubadmin/i18n";
import type { MyWaitlists } from "@clubadmin/shared";
import { formatDateTime, PersonName } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { getMyWaitlists } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

type Entry = MyWaitlists["entries"][number];

const NOTICES = ["applied", "accepted", "declined", "withdrawn"] as const;
const OPEN = new Set(["waiting", "offered", "accepted"]);

export async function generateMetadata() {
  return { title: (await getTranslations())("waitlist.myTitle") };
}

export default async function MyWaitlistsPage({ searchParams }: Props) {
  const [query, t, locale, mine] = await Promise.all([
    searchParams,
    getTranslations(),
    getLocale(),
    getMyWaitlists(),
  ]);
  const protectedLabel = t("protected.tooltip");
  const deadline = (e: Entry) =>
    e.offerExpiresAt
      ? formatDateTime(e.offerExpiresAt, {
          locale,
          timeZone: e.clubTimeZone ?? "UTC",
          dateStyle: "full",
          timeStyle: "short",
        })
      : "";
  const open = mine.entries.filter((e) => OPEN.has(e.status));
  const offers = open.filter((e) => e.status === "offered");
  const queued = open.filter((e) => e.status !== "offered");
  const closed = mine.entries.filter((e) => !OPEN.has(e.status));
  const head = (e: Entry) => (
    <div className="flex flex-wrap items-center gap-2">
      <PersonName person={e.person} protectedLabel={protectedLabel} />
      <span>
        · {e.group.name} ({e.club.name})
      </span>
    </div>
  );

  return (
    <div className="space-y-8" data-testid="my-waitlists">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("waitlist.myTitle")}</h1>
        <FormError code={query.error} />
        {NOTICES.map((n) =>
          query.updated === n ? <Notice key={n}>{t(`waitlist.notices.${n}`)}</Notice> : null,
        )}
      </div>
      {mine.entries.length === 0 ? <p className="text-muted">{t("waitlist.myEmpty")}</p> : null}

      {offers.length > 0 ? (
        <ul className="space-y-3">
          {offers.map((e) => (
            <li
              key={e.id}
              className="space-y-2 rounded-lg border border-accent p-4"
              data-testid="my-offer"
            >
              {head(e)}
              <p className="font-semibold">{t("waitlist.replyBy", { deadline: deadline(e) })}</p>
              {e.canAct ? (
                <div className="flex flex-wrap gap-2">
                  <ActionForm action="accept-offer">
                    <input type="hidden" name="entryId" value={e.id} />
                    <button type="submit" className={buttonClass} data-testid="accept-offer">
                      {t("waitlist.accept")}
                    </button>
                  </ActionForm>
                  <ActionForm action="decline-offer">
                    <input type="hidden" name="entryId" value={e.id} />
                    <button
                      type="submit"
                      className={secondaryButtonClass}
                      data-testid="decline-offer"
                    >
                      {t("waitlist.decline")}
                    </button>
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {queued.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {queued.map((e) => (
            <li key={e.id} className="space-y-2 px-4 py-3" data-testid="my-waitlist-entry">
              {head(e)}
              <p data-testid="my-waitlist-position">
                {e.position !== null
                  ? t("waitlist.position", { position: e.position, count: e.waiting })
                  : e.status === "accepted"
                    ? t("waitlist.awaitingClub")
                    : t(enumKey("waitlist.statuses", e.status))}
              </p>
              {e.canAct ? (
                <ActionForm action="withdraw-waitlist">
                  <input type="hidden" name="entryId" value={e.id} />
                  <button
                    type="submit"
                    className={secondaryButtonClass}
                    data-testid="leave-waitlist"
                  >
                    {t("waitlist.leave")}
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {closed.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("waitlist.recentlyClosed")}</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {closed.map((e) => (
              <li key={e.id} className="space-y-1 px-4 py-3 text-sm">
                {head(e)}
                <p className="text-muted">
                  {t(enumKey("waitlist.statuses", e.status))}
                  {e.closedReason
                    ? ` · ${t(enumKey("history.closedReasons", e.closedReason))}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
