// SPDX-License-Identifier: AGPL-3.0-only
// The attesters' queue (P2.5 part B, ADR 0048): claims of the groups the
// viewer attests (all of the club's for its attesters), approve or reject
// with a reason (never one's own), and the CSV export of approved claims
// for the club's attesters.
import { enumKey } from "@clubadmin/i18n";
import { EXPENSE_CLAIM_STATUSES } from "@clubadmin/shared";
import { formatDateTime, personLabel, RoleBadge } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { money } from "../../../../../components/billing.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getExpenseClaimQueue, getMyClubs, requireId } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("expenses.queue") };
}

export default async function ExpenseQueuePage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  requireId(clubId);
  const status =
    typeof query.status === "string" &&
    (EXPENSE_CLAIM_STATUSES as readonly string[]).includes(query.status)
      ? query.status
      : "submitted";
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, locale, page, mine] = await Promise.all([
    getTranslations(),
    getLocale(),
    getExpenseClaimQueue(clubId, status, cursor),
    getMyClubs(),
  ]);
  if (!page) notFound();
  const permissions = mine.clubs.find((c) => c.club.id === clubId)?.permissions ?? [];
  const canExport = permissions.includes("club.expenses.attest");
  const back = `/clubs/${clubId}/expenses?status=${status}`;
  const timeZone = mine.clubs.find((c) => c.club.id === clubId)?.club.timeZone ?? "UTC";
  const day = (iso: string) => formatDateTime(iso, { locale, timeZone, dateStyle: "medium" });
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("expenses.queue")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("expenses.queueIntro")}</p>
      </div>
      <FormError code={query.error} />
      {query.decided ? <Notice>{t("expenses.decided")}</Notice> : null}
      <nav className="flex flex-wrap gap-4 text-sm">
        {EXPENSE_CLAIM_STATUSES.filter((s) => s !== "paid").map((s) => (
          <a
            key={s}
            href={`/clubs/${clubId}/expenses?status=${s}`}
            className={s === status ? "font-semibold" : "underline"}
          >
            {t(enumKey("expenses.statuses", s))}
          </a>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <p className="text-muted" data-testid="queue-empty">
          {t("expenses.queueEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="claim-queue">
          {page.items.map((c) => (
            <li key={c.id} className="space-y-2 py-3" data-testid="queue-claim">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {c.claimant ? personLabel(c.claimant) : t("expenses.hiddenClaimant")}
                </span>
                <span className="tabular-nums">{money(locale, c.amountMinor, c.currency)}</span>
                <RoleBadge label={t(enumKey("expenses.statuses", c.status))} />
              </p>
              <p className="text-sm text-muted">
                {c.groupName} · {day(c.createdAt)}
                {c.routedTo
                  ? ` · ${t("expenses.routedTo", { name: personLabel(c.routedTo) })}`
                  : ""}
              </p>
              <ul className="text-sm">
                {c.lines.map((l) => (
                  <li key={l.id}>
                    {l.description} · {t("expenses.km", { km: l.quantity })} ·{" "}
                    {money(locale, l.amountMinor, c.currency)}
                  </li>
                ))}
              </ul>
              {c.reason ? <p className="text-sm">{c.reason}</p> : null}
              {c.canDecide ? (
                <div className="flex flex-wrap items-end gap-3">
                  <ActionForm action="expense-decide">
                    <input type="hidden" name="clubId" value={clubId} />
                    <input type="hidden" name="claimId" value={c.id} />
                    <input type="hidden" name="decision" value="approve" />
                    <input type="hidden" name="back" value={back} />
                    <button type="submit" className={buttonClass} data-testid="claim-approve">
                      {t("expenses.approve")}
                    </button>
                  </ActionForm>
                  <ActionForm action="expense-decide" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="clubId" value={clubId} />
                    <input type="hidden" name="claimId" value={c.id} />
                    <input type="hidden" name="decision" value="reject" />
                    <input type="hidden" name="back" value={back} />
                    <label className="block space-y-1">
                      <span className="text-sm">{t("expenses.reason")}</span>
                      <input name="reason" required maxLength={500} className={inputClass} />
                    </label>
                    <button
                      type="submit"
                      className={secondaryButtonClass}
                      data-testid="claim-reject"
                    >
                      {t("expenses.reject")}
                    </button>
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <a href={`${back}&cursor=${page.nextCursor}`} className="text-sm underline">
          {t("announcements.more")}
        </a>
      ) : null}
      {canExport ? (
        <section aria-labelledby="export" className="space-y-2">
          <h2 id="export" className="text-lg font-semibold">
            {t("expenses.export")}
          </h2>
          <p className="max-w-prose text-sm text-muted">{t("expenses.exportHint")}</p>
          <form
            method="get"
            action={`/api/v1/clubs/${clubId}/expense-claims/export`}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="block space-y-1">
              <span className="text-sm">{t("expenses.from")}</span>
              <input type="date" name="from" defaultValue={monthStart} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm">{t("expenses.to")}</span>
              <input type="date" name="to" defaultValue={today} className={inputClass} />
            </label>
            <button type="submit" className={secondaryButtonClass} data-testid="claims-export">
              {t("expenses.download")}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
