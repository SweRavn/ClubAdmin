// SPDX-License-Identifier: AGPL-3.0-only
// Billing in the web app (P1.13; only with billing on): amounts, the
// invoice list and the club's banners (trial ending for club managers, a
// payment overdue for managers and treasurers, read-only for everyone).
import { enumKey } from "@clubadmin/i18n";
import type { EntitlementsResponse, InvoiceSummary } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

const DAY = 86_400_000;
/** The club becomes read-only 30 days after the due date (decision 8). */
const READ_ONLY_AFTER_DAYS = 29;

export function money(locale: string, minor: number, currency: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

/** Club dates are shown in the club's time zone (Swedish clubs: Stockholm by default). */
export const DEFAULT_BILLING_TIME_ZONE = "Europe/Stockholm";

export function day(
  locale: string,
  iso: string | null | undefined,
  timeZone: string = DEFAULT_BILLING_TIME_ZONE,
): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  }).format(new Date(iso));
}

/** A period as its first and last day (the end is exclusive). */
/** The last day of a period whose end is exclusive. */
export const lastDay = (end: string) => new Date(Date.parse(end) - 1).toISOString();

export function period(
  locale: string,
  start: string,
  end: string,
  timeZone: string = DEFAULT_BILLING_TIME_ZONE,
): string {
  return `${day(locale, start, timeZone)} – ${day(locale, new Date(Date.parse(end) - 1).toISOString(), timeZone)}`;
}

export async function InvoiceTable({
  items,
  clubId,
  operator = false,
  testId = "invoices",
  timeZone = DEFAULT_BILLING_TIME_ZONE,
}: {
  timeZone?: string;
  items: InvoiceSummary[];
  clubId: string | null;
  operator?: boolean;
  testId?: string;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  if (items.length === 0) return <p className="text-muted">{t("billing.noInvoices")}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="text-muted">
          <tr>
            <th className="py-2 pr-3">{t("billing.number")}</th>
            {operator ? <th className="py-2 pr-3">{t("billing.ops.club")}</th> : null}
            <th className="py-2 pr-3">{t("billing.period")}</th>
            <th className="py-2 pr-3 text-right">{t("billing.amount")}</th>
            <th className="py-2 pr-3">{t("billing.status")}</th>
            <th className="py-2 pr-3">{t("billing.due")}</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((i) => {
            const club = clubId ?? i.club?.id ?? null;
            return (
              <tr key={i.id} data-testid="invoice-row">
                <td className="py-2 pr-3">
                  {club && !operator ? (
                    <a href={`/clubs/${club}/billing?invoice=${i.id}`} className="underline">
                      {i.number}
                    </a>
                  ) : (
                    i.number
                  )}
                  {i.kind === "credit_note" ? (
                    <span className="ml-2 text-muted">{t("billing.creditNote")}</span>
                  ) : null}
                </td>
                {operator ? (
                  <td className="py-2 pr-3">
                    <a href={`/ops/billing/clubs/${i.club?.id ?? ""}`} className="underline">
                      {i.club?.name}
                    </a>
                  </td>
                ) : null}
                <td className="py-2 pr-3">
                  {period(locale, i.periodStart, i.periodEnd, timeZone)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {money(locale, i.totalMinor, i.currency)}
                </td>
                <td className="py-2 pr-3">
                  {t(enumKey("billing.invoiceStatuses", i.status))}
                  {i.status === "open" && i.balanceMinor !== i.totalMinor
                    ? ` · ${t("billing.balance", { amount: money(locale, i.balanceMinor, i.currency) })}`
                    : ""}
                </td>
                <td className="py-2 pr-3">
                  {i.kind === "invoice" ? day(locale, i.dueAt, timeZone) : ""}
                </td>
                <td className="py-2">
                  {club && i.hasPdf && !operator ? (
                    <a
                      href={`/clubs/${club}/billing/invoices/${i.id}/pdf`}
                      className="underline"
                      data-testid="invoice-pdf"
                    >
                      {t("billing.downloadPdf")}
                    </a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The club's billing banner: read-only for everyone (with what to do), a
 * payment overdue and the trial's end for those who pay. Nothing with
 * billing off.
 */
export async function BillingBanner({
  clubId,
  entitlements,
  permissions,
}: {
  clubId: string;
  entitlements: EntitlementsResponse | null;
  permissions: readonly string[];
}) {
  if (!entitlements?.billingEnabled) return null;
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const payer = permissions.includes("billing.invoices.read");
  const chooser = permissions.includes("billing.subscription.change");
  const link = (
    <a
      href={`/clubs/${clubId}/billing`}
      className="ml-1 underline"
      data-testid="billing-banner-link"
    >
      {t("billing.banner.link")}
    </a>
  );
  if (entitlements.accessState === "read_only") {
    const byBilling = entitlements.accessStateSource === "billing";
    return (
      <p
        role="status"
        className="rounded-md bg-protected-soft px-3 py-2"
        data-testid="banner-read-only"
      >
        {t(byBilling ? "billing.banner.readOnly" : "billing.banner.readOnlyOperator")}{" "}
        {byBilling ? (
          payer ? (
            <>
              {t("billing.banner.readOnlyPayer")}
              {link}
            </>
          ) : (
            t("billing.banner.readOnlyOther")
          )
        ) : null}
      </p>
    );
  }
  if (entitlements.subscriptionStatus === "past_due" && payer && entitlements.pastDueSince) {
    const readOnly = new Date(
      Date.parse(entitlements.pastDueSince) + READ_ONLY_AFTER_DAYS * DAY,
    ).toISOString();
    return (
      <p
        role="status"
        className="rounded-md bg-protected-soft px-3 py-2"
        data-testid="banner-past-due"
      >
        {t("billing.banner.pastDue", { date: day(locale, readOnly) })}
        {link}
      </p>
    );
  }
  if (entitlements.subscriptionStatus === "trial" && chooser && entitlements.trialEndsAt) {
    const left = Math.ceil((Date.parse(entitlements.trialEndsAt) - Date.now()) / DAY);
    if (left <= 14) {
      return (
        <p role="status" className="rounded-md bg-accent-soft px-3 py-2" data-testid="banner-trial">
          {t("billing.banner.trial", { date: day(locale, entitlements.trialEndsAt), days: left })}
          {link}
        </p>
      );
    }
  }
  return null;
}
