// SPDX-License-Identifier: AGPL-3.0-only
// The club's billing page (P1.13; billing on only): the plan and status, the
// trial's end, what the plan includes, choosing a plan (club managers, with
// a second factor and the terms), pending changes, cancelling; the billing
// details and payment method (club managers and treasurers); invoices and
// credit notes with payment instructions and PDFs.
import { enumKey } from "@clubadmin/i18n";
import { isUuid } from "@clubadmin/shared";
import { forbidden, notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { day, InvoiceTable, lastDay, money, period } from "../../../../../components/billing.tsx";
import { CopyButton } from "../../../../../components/copy-button.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getBillingAccount,
  getClub,
  getClubPlans,
  getEntitlements,
  getInvoice,
  getInvoices,
  getMyClubs,
  getSubscription,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export async function generateMetadata() {
  return { title: (await getTranslations())("billing.title") };
}

export default async function BillingPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, mine, entitlements] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getMyClubs(),
    getEntitlements(clubId),
  ]);
  if (!entitlements?.billingEnabled) notFound();
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("billing.subscription.read")) forbidden();
  const canChoose = permissions.includes("billing.subscription.change");
  const canDetails = permissions.includes("billing.account.manage");
  const canInvoices = permissions.includes("billing.invoices.read");
  const cursor = one(query.cursor);
  const invoiceId = one(query.invoice);
  const [{ subscription }, plans, { account }, invoices, invoice] = await Promise.all([
    getSubscription(club.id),
    getClubPlans(club.id),
    getBillingAccount(club.id),
    canInvoices ? getInvoices(club.id, cursor || null) : Promise.resolve(null),
    canInvoices && isUuid(invoiceId) ? getInvoice(club.id, invoiceId) : Promise.resolve(null),
  ]);
  const currency = plans.currency;
  const tz = club.timeZone;
  const planName = (key: string | null | undefined) =>
    plans.plans.find((p) => p.key === key)?.name ?? key ?? "";
  const current = plans.plans.find((p) => p.key === subscription?.planKey);
  const bases = plans.plans.filter((p) => p.kind === "base");
  const addOns = plans.plans.filter((p) => p.kind === "add_on");
  const price = (p: (typeof plans.plans)[number], periodKey: "month" | "year") => {
    const x = p.prices[periodKey];
    if (!x) return null;
    return {
      excl: money(locale, x.exclVatMinor, currency),
      incl: money(locale, x.inclVatMinor, currency),
    };
  };
  const saved = one(query.saved);

  return (
    <div className="space-y-8" data-testid="billing-page">
      <h1 className="text-2xl font-semibold">{t("billing.title")}</h1>
      <FormError code={query.error} />
      {saved ? <Notice>{t(enumKey("billing.saved", saved))}</Notice> : null}

      {/* The subscription. */}
      <section
        aria-labelledby="billing-plan"
        className="space-y-3 rounded-lg border border-border p-4"
      >
        <h2 id="billing-plan" className="text-lg font-semibold">
          {t("billing.subscription")}
        </h2>
        {subscription ? (
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"
            data-testid="billing-subscription"
          >
            <dt className="text-muted">{t("billing.plan")}</dt>
            <dd data-testid="billing-plan-name">
              {planName(subscription.planKey)}
              {subscription.addOns.length > 0
                ? ` + ${subscription.addOns.map((a) => planName(a)).join(", ")}`
                : ""}
            </dd>
            <dt className="text-muted">{t("billing.status")}</dt>
            <dd data-testid="billing-status">
              {t(enumKey("billing.statuses", subscription.status))}
            </dd>
            {subscription.status === "trial" && subscription.trialEndsAt ? (
              <>
                <dt className="text-muted">{t("billing.trialEnds")}</dt>
                <dd>{day(locale, subscription.trialEndsAt, tz)}</dd>
              </>
            ) : null}
            {subscription.currentPeriodEnd && subscription.status !== "trial" ? (
              <>
                <dt className="text-muted">{t("billing.periodEnds")}</dt>
                <dd>
                  {day(
                    locale,
                    subscription.currentPeriodEnd ? lastDay(subscription.currentPeriodEnd) : null,
                    tz,
                  )}
                </dd>
              </>
            ) : null}
            {subscription.balanceDueMinor ? (
              <>
                <dt className="text-muted">{t("billing.balanceDue")}</dt>
                <dd>{money(locale, subscription.balanceDueMinor, currency)}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-muted">{t("billing.noSubscription")}</p>
        )}
        {current ? (
          <p className="text-sm text-muted">
            {t("billing.includes")}{" "}
            {Object.entries(current.features)
              .filter(([, on]) => on)
              .map(([f]) => t(enumKey("billing.features", f)))
              .join(", ") || t("billing.includesNothing")}
          </p>
        ) : null}
        {subscription?.scheduledChange ? (
          <div className="rounded-md bg-accent-soft px-3 py-2" data-testid="billing-scheduled">
            {t("billing.scheduled", {
              plan: planName(subscription.scheduledChange.planKey),
              date: day(locale, subscription.scheduledChange.at, tz),
            })}
            {canChoose ? (
              <ActionForm action="resume-subscription" className="mt-2">
                <input type="hidden" name="clubId" value={club.id} />
                <button type="submit" className={secondaryButtonClass} data-testid="billing-undo">
                  {t("billing.undo")}
                </button>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
        {subscription?.cancelAtPeriodEnd ? (
          <div className="rounded-md bg-protected-soft px-3 py-2" data-testid="billing-cancelled">
            {t("billing.cancelPending", {
              date: day(
                locale,
                subscription.currentPeriodEnd ? lastDay(subscription.currentPeriodEnd) : null,
                tz,
              ),
            })}
            {canChoose ? (
              <ActionForm action="resume-subscription" className="mt-2">
                <input type="hidden" name="clubId" value={club.id} />
                <button type="submit" className={secondaryButtonClass}>
                  {t("billing.resume")}
                </button>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Choosing a plan: club managers. */}
      {canChoose && subscription ? (
        <section
          aria-labelledby="billing-choose"
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <h2 id="billing-choose" className="text-lg font-semibold">
            {t("billing.choose")}
          </h2>
          <p className="text-sm text-muted">{t(enumKey("billing.vatNotes", plans.vatNote))}</p>
          {!plans.paidPlansAvailable ? (
            <p className="text-sm">{t("billing.paidUnavailable")}</p>
          ) : null}
          <ActionForm action="select-plan" className="space-y-4" testId="billing-choose-form">
            <input type="hidden" name="clubId" value={club.id} />
            <fieldset className="space-y-2">
              <legend className="font-medium">{t("billing.billingPeriod")}</legend>
              {(["month", "year"] as const).map((p) => (
                <label key={p} className="mr-4 inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="billingPeriod"
                    value={p}
                    defaultChecked={(subscription.billingPeriod ?? "month") === p}
                  />
                  {t(`billing.periods.${p}`)}
                </label>
              ))}
            </fieldset>
            <fieldset className="grid gap-3 md:grid-cols-2">
              <legend className="mb-2 font-medium">{t("billing.plans")}</legend>
              {bases.map((p) => {
                const month = price(p, "month");
                const year = price(p, "year");
                return (
                  <label
                    key={p.key}
                    className="flex gap-3 rounded-md border border-border p-3"
                    data-testid={`plan-${p.key}`}
                  >
                    <input
                      type="radio"
                      name="planKey"
                      value={p.key}
                      defaultChecked={
                        (subscription.scheduledChange?.planKey ?? subscription.planKey) === p.key
                      }
                      required
                    />
                    <span className="space-y-1">
                      <span className="block font-medium">{p.name}</span>
                      {month ? (
                        <span className="block text-sm">
                          {t("billing.pricePerMonth", { excl: month.excl, incl: month.incl })}
                        </span>
                      ) : null}
                      {year ? (
                        <span className="block text-sm">
                          {t("billing.pricePerYear", { excl: year.excl, incl: year.incl })}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {addOns.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="font-medium">{t("billing.addOns")}</legend>
                {addOns.map((p) => {
                  const month = price(p, "month");
                  return (
                    <label key={p.key} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="addOn"
                        value={p.key}
                        defaultChecked={(
                          subscription.scheduledChange?.addOns ?? subscription.addOns
                        ).includes(p.key)}
                      />
                      <span>
                        {p.name}
                        {month
                          ? ` · ${t("billing.pricePerMonth", { excl: month.excl, incl: month.incl })}`
                          : ""}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ) : null}
            <label className="flex items-start gap-2">
              <input type="checkbox" name="acceptTerms" value="1" data-testid="billing-terms" />
              <span>
                {t("billing.acceptTerms", { version: plans.termsVersion })}
                {plans.termsUrl ? (
                  <>
                    {" "}
                    <a href={plans.termsUrl} className="underline" target="_blank" rel="noreferrer">
                      {t("billing.readTerms")}
                    </a>
                  </>
                ) : null}
              </span>
            </label>
            {subscription.status === "trial" ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" name="startNow" value="1" />
                <span>{t("billing.startNow")}</span>
              </label>
            ) : null}
            <p className="text-sm text-muted">{t("billing.chooseHint")}</p>
            <button type="submit" className={buttonClass} data-testid="billing-choose-submit">
              {t("billing.chooseSubmit")}
            </button>
          </ActionForm>
          {subscription.status !== "trial" && !subscription.cancelAtPeriodEnd ? (
            <ActionForm action="cancel-subscription">
              <input type="hidden" name="clubId" value={club.id} />
              <button type="submit" className={secondaryButtonClass} data-testid="billing-cancel">
                {t("billing.cancel")}
              </button>
              <p className="mt-1 text-sm text-muted">{t("billing.cancelHint")}</p>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {/* Billing details: club managers and treasurers. */}
      {canDetails ? (
        <section
          aria-labelledby="billing-details"
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <h2 id="billing-details" className="text-lg font-semibold">
            {t("billing.details")}
          </h2>
          <p className="text-sm text-muted">{t("billing.detailsHint")}</p>
          <ActionForm
            action="save-billing-account"
            className="grid gap-3 md:grid-cols-2"
            testId="billing-account-form"
          >
            <input type="hidden" name="clubId" value={club.id} />
            {(
              [
                ["legalName", account?.legalName ?? club.name, true],
                ["organizationNumber", account?.organizationNumber ?? "", false],
                ["vatNumber", account?.vatNumber ?? "", false],
                ["street", account?.address?.street ?? "", true],
                ["postalCode", account?.address?.postalCode ?? "", true],
                ["city", account?.address?.city ?? "", true],
                ["country", account?.address?.country ?? "SE", true],
                ["invoiceEmail", account?.invoiceEmail ?? "", true],
                ["reference", account?.reference ?? "", false],
              ] as const
            ).map(([name, value, required]) => (
              <label key={name} className="space-y-1">
                <span className="block text-sm font-medium">{t(`billing.fields.${name}`)}</span>
                <input
                  name={name}
                  defaultValue={value}
                  required={required}
                  type={name === "invoiceEmail" ? "email" : "text"}
                  className={inputClass}
                  data-testid={`billing-${name}`}
                />
                {name === "invoiceEmail" || name === "reference" ? (
                  <span className="block text-xs text-muted">
                    {t(`billing.fieldHints.${name}`)}
                  </span>
                ) : null}
              </label>
            ))}
            <label className="space-y-1">
              <span className="block text-sm font-medium">{t("billing.fields.invoiceLocale")}</span>
              <select
                name="invoiceLocale"
                defaultValue={account?.invoiceLocale ?? "sv"}
                className={inputClass}
              >
                {(["sv", "en", "nb"] as const).map((l) => (
                  <option key={l} value={l}>
                    {t(`locales.${l}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="md:col-span-2">
              <button type="submit" className={buttonClass} data-testid="billing-account-save">
                {t("billing.saveDetails")}
              </button>
            </div>
          </ActionForm>
          <div className="space-y-2">
            <h3 className="font-medium">{t("billing.paymentMethod")}</h3>
            <p data-testid="billing-method">
              {t(enumKey("billing.methods", account?.paymentMethod ?? "invoice"))}
            </p>
            <p className="text-sm text-muted">{t("billing.cardLater")}</p>
          </div>
        </section>
      ) : null}

      {/* One invoice opened from the list or a notice. */}
      {invoice ? (
        <section
          aria-labelledby="billing-invoice"
          className="space-y-3 rounded-lg border border-border p-4"
          data-testid="billing-invoice"
        >
          <h2 id="billing-invoice" className="text-lg font-semibold">
            {t(
              invoice.kind === "credit_note" ? "billing.creditNoteNumber" : "billing.invoiceNumber",
              {
                number: invoice.number ?? "",
              },
            )}
          </h2>
          <ul className="divide-y divide-border text-sm">
            {invoice.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3 py-1">
                <span>
                  {l.planName ?? l.planKey}
                  {l.proration ? ` (${t("billing.prorated")})` : ""}
                  {l.periodStart && l.periodEnd
                    ? ` · ${period(locale, l.periodStart, l.periodEnd, tz)}`
                    : ""}
                </span>
                <span className="tabular-nums">
                  {money(locale, l.amountMinor, invoice.currency)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-sm">
            <dt>{t("billing.subtotal")}</dt>
            <dd className="text-right tabular-nums">
              {money(locale, invoice.subtotalMinor, invoice.currency)}
            </dd>
            {invoice.vatSummary.map((v) => (
              <div key={v.rateBp} className="contents">
                <dt>{t("billing.vat", { rate: v.rateBp / 100 })}</dt>
                <dd className="text-right tabular-nums">
                  {money(locale, v.vatMinor, invoice.currency)}
                </dd>
              </div>
            ))}
            <dt className="font-semibold">{t("billing.total")}</dt>
            <dd className="text-right font-semibold tabular-nums">
              {money(locale, invoice.totalMinor, invoice.currency)}
            </dd>
          </dl>
          {invoice.instructions ? (
            <div
              className="space-y-1 rounded-md bg-accent-soft px-3 py-2"
              data-testid="billing-instructions"
            >
              <p>
                {t("billing.payTo", {
                  amount: money(locale, invoice.instructions.amountMinor, invoice.currency),
                  due: day(locale, invoice.dueAt, tz),
                })}
              </p>
              <p>
                {t("billing.bankgiro")}:{" "}
                <span className="font-mono">{invoice.instructions.bankgiro}</span>{" "}
                <CopyButton
                  text={invoice.instructions.bankgiro}
                  label={t("billing.copy")}
                  done={t("billing.copied")}
                />
              </p>
              <p>
                {t("billing.ocr")}:{" "}
                <span className="font-mono">{invoice.instructions.ocrReference}</span>{" "}
                <CopyButton
                  text={invoice.instructions.ocrReference}
                  label={t("billing.copy")}
                  done={t("billing.copied")}
                />
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Invoices: club managers and treasurers. */}
      {invoices ? (
        <section aria-labelledby="billing-invoices" className="space-y-3">
          <h2 id="billing-invoices" className="text-lg font-semibold">
            {t("billing.invoices")}
          </h2>
          <InvoiceTable items={invoices.items} clubId={club.id} timeZone={tz} />
          {invoices.nextCursor ? (
            <a
              href={`/clubs/${club.id}/billing?cursor=${invoices.nextCursor}`}
              className="underline"
            >
              {t("billing.showMore")}
            </a>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
