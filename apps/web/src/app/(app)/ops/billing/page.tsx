// SPDX-License-Identifier: AGPL-3.0-only
// Operator console, billing (P1.13): every club's subscription with filters
// and keyset paging, the latest invoices and payments, the CSV exports for
// bookkeeping, and the plan catalogue (activate, deactivate).
import { enumKey } from "@clubadmin/i18n";
import { isUuid, SUBSCRIPTION_STATUSES } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  inputClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { day, InvoiceTable, money } from "../../../../components/billing.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import {
  getOpsInvoices,
  getOpsPayments,
  getOpsPlans,
  getOpsSubscriptions,
} from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export async function generateMetadata() {
  return { title: (await getTranslations())("billing.ops.title") };
}

export default async function OpsBillingPage({ searchParams }: Props) {
  const query = await searchParams;
  const filter = new URLSearchParams();
  const status = one(query.status);
  const plan = one(query.plan);
  if ((SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) filter.set("status", status);
  if (/^[a-z0-9_]{1,64}$/.test(plan)) filter.set("plan", plan);
  if (isUuid(one(query.cursor))) filter.set("cursor", one(query.cursor));
  const [t, locale, subscriptions, invoices, payments, { plans }] = await Promise.all([
    getTranslations(),
    getLocale(),
    getOpsSubscriptions(filter.toString()),
    getOpsInvoices("limit=20"),
    getOpsPayments("limit=20"),
    getOpsPlans(),
  ]);
  const next = new URLSearchParams(filter);
  if (subscriptions?.nextCursor) next.set("cursor", subscriptions.nextCursor);
  const firstOfMonth = new Date().toISOString().slice(0, 8) + "01";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-8" data-testid="ops-billing">
      <h1 className="text-2xl font-semibold">{t("billing.ops.title")}</h1>
      <FormError code={query.error} />
      {one(query.saved) ? <Notice>{t("billing.ops.saved")}</Notice> : null}

      <section aria-labelledby="ops-subscriptions" className="space-y-3">
        <h2 id="ops-subscriptions" className="text-lg font-semibold">
          {t("billing.ops.subscriptions")}
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-sm">{t("billing.status")}</span>
            <select name="status" defaultValue={status} className={inputClass}>
              <option value="">{t("billing.ops.all")}</option>
              {SUBSCRIPTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(enumKey("billing.statuses", s))}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-sm">{t("billing.plan")}</span>
            <select name="plan" defaultValue={plan} className={inputClass}>
              <option value="">{t("billing.ops.all")}</option>
              {plans
                .filter((p) => p.kind === "base")
                .map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" className={secondaryButtonClass}>
            {t("billing.ops.filter")}
          </button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="ops-subscriptions">
            <thead className="text-muted">
              <tr>
                <th className="py-2 pr-3">{t("billing.ops.club")}</th>
                <th className="py-2 pr-3">{t("billing.plan")}</th>
                <th className="py-2 pr-3">{t("billing.status")}</th>
                <th className="py-2 pr-3">{t("billing.periodEnds")}</th>
                <th className="py-2 pr-3 text-right">{t("billing.balanceDue")}</th>
                <th className="py-2">{t("billing.paymentMethod")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(subscriptions?.items ?? []).map((s) => (
                <tr key={s.subscriptionId} data-testid="ops-subscription">
                  <td className="py-2 pr-3">
                    <a href={`/ops/billing/clubs/${s.club.id}`} className="underline">
                      {s.club.name}
                    </a>{" "}
                    <span className="text-muted">{s.club.country}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {s.planKey}
                    {s.addOns.length > 0 ? ` + ${s.addOns.join(", ")}` : ""}
                  </td>
                  <td className="py-2 pr-3">
                    {t(enumKey("billing.statuses", s.status))}
                    {s.accessState !== "active" ? ` · ${s.accessState}` : ""}
                  </td>
                  <td className="py-2 pr-3">{day(locale, s.trialEndsAt ?? s.currentPeriodEnd)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {money(locale, s.balanceDueMinor, "SEK")}
                  </td>
                  <td className="py-2">
                    {s.paymentMethod ? t(enumKey("billing.methods", s.paymentMethod)) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {subscriptions?.nextCursor ? (
          <a href={`/ops/billing?${next.toString()}`} className="underline">
            {t("billing.showMore")}
          </a>
        ) : null}
      </section>

      <section
        aria-labelledby="ops-exports"
        className="space-y-3 rounded-lg border border-border p-4"
      >
        <h2 id="ops-exports" className="text-lg font-semibold">
          {t("billing.ops.exports")}
        </h2>
        {(["invoices", "payments"] as const).map((kind) => (
          <form
            key={kind}
            method="get"
            action={`/api/v1/billing/${kind}.csv`}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="space-y-1">
              <span className="block text-sm">{t("billing.ops.from")}</span>
              <input type="date" name="from" defaultValue={firstOfMonth} className={inputClass} />
            </label>
            <label className="space-y-1">
              <span className="block text-sm">{t("billing.ops.to")}</span>
              <input type="date" name="to" defaultValue={today} className={inputClass} />
            </label>
            <button
              type="submit"
              className={secondaryButtonClass}
              data-testid={`ops-export-${kind}`}
            >
              {t(`billing.ops.export.${kind}`)}
            </button>
          </form>
        ))}
      </section>

      <section aria-labelledby="ops-invoices" className="space-y-3">
        <h2 id="ops-invoices" className="text-lg font-semibold">
          {t("billing.ops.latestInvoices")}
        </h2>
        <InvoiceTable items={invoices.items} clubId={null} operator testId="ops-invoices" />
      </section>

      <section aria-labelledby="ops-payments" className="space-y-3">
        <h2 id="ops-payments" className="text-lg font-semibold">
          {t("billing.ops.latestPayments")}
        </h2>
        {payments.items.length === 0 ? (
          <p className="text-muted">{t("billing.ops.noPayments")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="ops-payments">
            {payments.items.map((p) => (
              <li key={p.id} className="flex flex-wrap justify-between gap-3 py-2">
                <span>
                  {p.club?.name} · {p.invoiceNumber} · {p.receivedOn ?? day(locale, p.recordedAt)}
                </span>
                <span className="tabular-nums">{money(locale, p.amountMinor, p.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ops-plans" className="space-y-3">
        <h2 id="ops-plans" className="text-lg font-semibold">
          {t("billing.plans")}
        </h2>
        <ul className="divide-y divide-border text-sm" data-testid="ops-plans">
          {plans.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span>
                <span className="font-medium">{p.name}</span>{" "}
                <span className="text-muted">{p.key}</span>
                {" · "}
                {(p.prices ?? [])
                  .map(
                    (x) =>
                      `${money(locale, x.priceMinor, x.currency)}/${t(`billing.periods.${x.period}`)}`,
                  )
                  .join(", ")}
                {p.active ? "" : ` · ${t("billing.ops.inactive")}`}
              </span>
              <ActionForm action="ops-plan-active">
                <input type="hidden" name="planId" value={p.id} />
                <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                <button type="submit" className={secondaryButtonClass}>
                  {t(p.active ? "billing.ops.deactivate" : "billing.ops.activate")}
                </button>
              </ActionForm>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">{t("billing.ops.plansHint")}</p>
      </section>
    </div>
  );
}
