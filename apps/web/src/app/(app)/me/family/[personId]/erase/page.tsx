// SPDX-License-Identifier: AGPL-3.0-only
// Erasing my child (P1.8b): for a full guardian of a ward without a login.
// What happens and when, what must be settled first, and a confirmation;
// while an erasure is planned (by me or another parent), "Cancel".

import { formatDateTime, personLabel } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../../components/action-form.tsx";
import { ErasureBlockers } from "../../../../../../components/erasure-blockers.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { getMyWards, getWardErasure, requireId } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("privacy.deletion.title") };
}

export default async function EraseWardPage({ params, searchParams }: Props) {
  const personId = requireId((await params).personId);
  const [t, locale, timeZone, query, preview, wards] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    searchParams,
    getWardErasure(personId),
    getMyWards(),
  ]);
  const ward = wards.wards.find((w) => w.person.id === personId);
  if (!preview || !ward) notFound();
  const name = personLabel(ward.person);
  const date = (iso: string) => formatDateTime(iso, { locale, timeZone, dateStyle: "long" });
  const when = date(new Date(Date.now() + preview.graceDays * 86_400_000).toISOString());
  return (
    <div className="max-w-2xl space-y-6" data-testid="erase-ward">
      <h1 className="text-2xl font-semibold">{t("privacy.wardErasure.title", { name })}</h1>
      <FormError code={query.error} />
      {query.cancelled ? <Notice>{t("privacy.wardErasure.cancelled")}</Notice> : null}
      {preview.hasLogin ? (
        <p>{t("privacy.wardErasure.hasLogin", { name })}</p>
      ) : preview.pending ? (
        <section className="space-y-3" data-testid="ward-erasure-pending">
          <p>
            {t("privacy.wardErasure.scheduled", {
              name,
              date: date(preview.pending.scheduledFor),
            })}
          </p>
          {preview.pending.kind === "ward_erasure" ? (
            <ActionForm action="cancel-ward-erasure" back={`/me/family/${personId}/erase`}>
              <input type="hidden" name="personId" value={personId} />
              <button type="submit" className={buttonClass} data-testid="cancel-ward-erasure">
                {t("privacy.wardErasure.cancel")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : (
        <>
          <p className="text-sm">
            {t("privacy.wardErasure.intro", { name, days: preview.graceDays })}
          </p>
          <ErasureBlockers blockers={preview.blockers} />
          <ActionForm
            action="schedule-ward-erasure"
            back={`/me/family/${personId}/erase`}
            className="space-y-4"
          >
            <input type="hidden" name="personId" value={personId} />
            <label className="flex items-start gap-2">
              <input type="checkbox" name="confirm" required data-testid="confirm-ward-erasure" />
              <span>{t("privacy.wardErasure.confirm", { name, date: when })}</span>
            </label>
            <button
              type="submit"
              className={buttonClass}
              disabled={preview.blockers.length > 0}
              data-testid="schedule-ward-erasure"
            >
              {t("privacy.wardErasure.button", { name })}
            </button>
          </ActionForm>
        </>
      )}
    </div>
  );
}
