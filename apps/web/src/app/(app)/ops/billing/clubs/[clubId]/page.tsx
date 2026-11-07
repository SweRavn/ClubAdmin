// SPDX-License-Identifier: AGPL-3.0-only
// Operator console, one club's billing (P1.13): subscription, billing
// details, invoices with payments and credit notes; assign a plan, change
// the status, extend the trial, record a bank payment, issue a credit note,
// email an invoice again. Club name and country only, never member data.
import { enumKey } from "@clubadmin/i18n";
import { CREDIT_REASONS, SUBSCRIPTION_STATUSES } from "@clubadmin/shared";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { day, money, period } from "../../../../../../components/billing.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import {
  getBillingAccount,
  getInvoices,
  getOpsPlans,
  getOpsSubscriptions,
  getSubscription,
  requireId,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function OpsClubBillingPage({ params, searchParams }: Props) {
  const [{ clubId: raw }, query] = await Promise.all([params, searchParams]);
  const clubId = requireId(raw);
  const [t, locale, listed, { subscription }, { account }, invoices, { plans }] = await Promise.all(
    [
      getTranslations(),
      getLocale(),
      getOpsSubscriptions(`clubId=${clubId}&limit=1`),
      getSubscription(clubId),
      getBillingAccount(clubId),
      getInvoices(clubId, null),
      getOpsPlans(),
    ],
  );
  const club = listed?.items[0]?.club;
  if (!club || !subscription) notFound();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-8" data-testid="ops-club-billing">
      <h1 className="text-2xl font-semibold">
        {club.name} <span className="text-base text-muted">{club.country}</span>
      </h1>
      <FormError code={query.error} />
      {typeof query.saved === "string" ? <Notice>{t("billing.ops.saved")}</Notice> : null}

      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold">{t("billing.subscription")}</h2>
        <p>
          {subscription.planKey}
          {subscription.addOns.length ? ` + ${subscription.addOns.join(", ")}` : ""} ·{" "}
          {t(enumKey("billing.statuses", subscription.status))}
          {subscription.trialEndsAt && subscription.status === "trial"
            ? ` · ${t("billing.trialEnds")} ${day(locale, subscription.trialEndsAt)}`
            : ""}
          {subscription.currentPeriodEnd
            ? ` · ${t("billing.periodEnds")} ${day(locale, subscription.currentPeriodEnd)}`
            : ""}
        </p>
        <div className="flex flex-wrap gap-6">
          <ActionForm action="ops-assign-plan" className="flex items-end gap-2">
            <input type="hidden" name="clubId" value={clubId} />
            <label className="space-y-1">
              <span className="block text-sm">{t("billing.ops.assignPlan")}</span>
              <select name="planKey" defaultValue={subscription.planKey} className={inputClass}>
                {plans
                  .filter((p) => p.kind === "base" && p.active)
                  .map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("billing.ops.apply")}
            </button>
          </ActionForm>
          <ActionForm action="ops-subscription-status" className="flex items-end gap-2">
            <input type="hidden" name="clubId" value={clubId} />
            <label className="space-y-1">
              <span className="block text-sm">{t("billing.ops.changeStatus")}</span>
              <select name="status" defaultValue={subscription.status} className={inputClass}>
                {SUBSCRIPTION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(enumKey("billing.statuses", s))}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("billing.ops.apply")}
            </button>
          </ActionForm>
          {subscription.status === "trial" ? (
            <ActionForm action="ops-set-trial" className="flex items-end gap-2">
              <input type="hidden" name="clubId" value={clubId} />
              <label className="space-y-1">
                <span className="block text-sm">{t("billing.ops.trialEndsOn")}</span>
                <input
                  type="date"
                  name="trialEndsOn"
                  defaultValue={subscription.trialEndsAt?.slice(0, 10)}
                  className={inputClass}
                />
              </label>
              <button type="submit" className={secondaryButtonClass}>
                {t("billing.ops.apply")}
              </button>
            </ActionForm>
          ) : null}
        </div>
      </section>

      <section className="space-y-2 rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold">{t("billing.details")}</h2>
        {account ? (
          <p className="text-sm">
            {account.legalName}
            {account.organizationNumber ? ` · ${account.organizationNumber}` : ""}
            {account.address
              ? ` · ${account.address.street}, ${account.address.postalCode} ${account.address.city}, ${account.address.country}`
              : ""}
            {account.invoiceEmail ? ` · ${account.invoiceEmail}` : ""} ·{" "}
            {t(enumKey("billing.methods", account.paymentMethod))}
          </p>
        ) : (
          <p className="text-muted">{t("billing.ops.noDetails")}</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("billing.invoices")}</h2>
        {(invoices?.items ?? []).length === 0 ? (
          <p className="text-muted">{t("billing.noInvoices")}</p>
        ) : null}
        <ul className="space-y-3" data-testid="ops-club-invoices">
          {(invoices?.items ?? []).map((i) => (
            <li key={i.id} className="space-y-2 rounded-md border border-border p-3">
              <p>
                <span className="font-medium">{i.number}</span>
                {i.kind === "credit_note" ? ` · ${t("billing.creditNote")}` : ""} ·{" "}
                {period(locale, i.periodStart, i.periodEnd)} ·{" "}
                {money(locale, i.totalMinor, i.currency)} ·{" "}
                {t(enumKey("billing.invoiceStatuses", i.status))}
                {i.status === "open"
                  ? ` · ${t("billing.balance", { amount: money(locale, i.balanceMinor, i.currency) })}`
                  : ""}
              </p>
              {i.kind === "invoice" && i.status === "open" ? (
                <ActionForm action="ops-record-payment" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="invoiceId" value={i.id} />
                  <label className="space-y-1">
                    <span className="block text-sm">{t("billing.amount")}</span>
                    <input
                      name="amount"
                      inputMode="decimal"
                      defaultValue={(i.balanceMinor / 100).toFixed(2)}
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-sm">{t("billing.ops.receivedOn")}</span>
                    <input
                      type="date"
                      name="receivedOn"
                      defaultValue={today}
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-sm">{t("billing.ops.reference")}</span>
                    <input name="reference" required className={inputClass} />
                  </label>
                  <button type="submit" className={buttonClass}>
                    {t("billing.ops.recordPayment")}
                  </button>
                </ActionForm>
              ) : null}
              {i.kind === "invoice" && i.status !== "void" ? (
                <div className="flex flex-wrap gap-3">
                  <ActionForm action="ops-credit-note" className="flex items-end gap-2">
                    <input type="hidden" name="invoiceId" value={i.id} />
                    <label className="space-y-1">
                      <span className="block text-sm">{t("billing.ops.creditReason")}</span>
                      <select name="reason" className={inputClass}>
                        {CREDIT_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {t(enumKey("billing.ops.reasons", r))}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className={secondaryButtonClass}>
                      {t("billing.ops.creditAll")}
                    </button>
                  </ActionForm>
                  <ActionForm action="ops-resend-invoice">
                    <input type="hidden" name="invoiceId" value={i.id} />
                    <button type="submit" className={secondaryButtonClass}>
                      {t("billing.ops.resend")}
                    </button>
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
