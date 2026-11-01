// SPDX-License-Identifier: AGPL-3.0-only
// Deleting my account (P1.8b): what happens and when, what must be settled
// first (per club), my children without a login (erased too unless I keep
// them), and a confirmation that names the date. While a deletion is
// planned, the page shows the date and "Cancel deletion".

import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../components/action-form.tsx";
import { ErasureBlockers } from "../../../../../components/erasure-blockers.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getDeletionPreview } from "../../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("privacy.deletion.heading") };
}

export default async function DeleteAccountPage({ searchParams }: Props) {
  const [t, locale, timeZone, query, preview] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    searchParams,
    getDeletionPreview(),
  ]);
  const date = (iso: string) => formatDateTime(iso, { locale, timeZone, dateStyle: "long" });
  const when = date(new Date(Date.now() + preview.graceDays * 86_400_000).toISOString());
  const blockers = [...preview.blockers, ...preview.wards.flatMap((w) => w.blockers)];
  return (
    <div className="max-w-2xl space-y-6" data-testid="delete-account">
      <h1 className="text-2xl font-semibold">{t("privacy.deletion.heading")}</h1>
      <FormError code={query.error} />
      {query.cancelled ? <Notice>{t("privacy.deletion.cancelled")}</Notice> : null}
      {preview.pending ? (
        <section className="space-y-3" data-testid="deletion-pending">
          <p>{t("privacy.deletion.scheduled", { date: date(preview.pending.scheduledFor) })}</p>
          <ActionForm action="cancel-deletion" back="/me/privacy/delete">
            <button type="submit" className={buttonClass} data-testid="cancel-deletion">
              {t("privacy.deletion.cancelButton")}
            </button>
          </ActionForm>
        </section>
      ) : (
        <>
          <p className="text-sm">
            {t("privacy.deletion.whatHappens", { days: preview.graceDays })}
          </p>
          <ErasureBlockers blockers={blockers} />
          <ActionForm action="schedule-deletion" back="/me/privacy/delete" className="space-y-4">
            {preview.wards.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="font-semibold">{t("privacy.deletion.wardsTitle")}</legend>
                <p className="text-sm text-muted">{t("privacy.deletion.wardsIntro")}</p>
                {preview.wards.map((w) => (
                  <label key={w.person.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="eraseWard"
                      value={w.person.id}
                      defaultChecked
                      data-testid={`erase-ward-${w.person.id}`}
                    />
                    {t("privacy.deletion.eraseWard", { name: personLabel(w.person) })}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <label className="flex items-start gap-2">
              <input type="checkbox" name="confirm" required data-testid="confirm-deletion" />
              <span>{t("privacy.deletion.confirm", { date: when })}</span>
            </label>
            <button
              type="submit"
              className={buttonClass}
              disabled={blockers.length > 0}
              data-testid="schedule-deletion"
            >
              {t("privacy.deletion.confirmButton")}
            </button>
          </ActionForm>
        </>
      )}
    </div>
  );
}
