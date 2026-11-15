// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents (P2.4, ADR 0049): the club's series (statutes,
// minutes, policies) with their documents and status. Those who manage
// governing documents create series and drafts.
import { enumKey } from "@clubadmin/i18n";
import { SERIES_KINDS } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getDocumentSeries, getFolder } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("governing.title") };
}

export default async function GoverningPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, series] = await Promise.all([getTranslations(), getDocumentSeries(clubId, null)]);
  const contents = await Promise.all(series.items.map((s) => getFolder(clubId, s.id, null)));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("governing.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("governing.intro")}</p>
      </div>
      <FormError code={query.error} />
      {query.created ? <Notice>{t("governing.saved")}</Notice> : null}
      {series.items.length === 0 ? (
        <p className="text-muted" data-testid="no-series">
          {t("governing.noSeries")}
        </p>
      ) : null}
      {series.items.map((s, i) => {
        const content = contents[i]!;
        return (
          <section key={s.id} className="space-y-2" data-testid="series">
            <h2 className="text-lg font-semibold">
              {s.name}{" "}
              <span className="text-sm font-normal text-muted">
                {t(enumKey("governing.seriesKinds", s.seriesKind))}
              </span>
            </h2>
            {content.documents.length === 0 ? (
              <p className="text-sm text-muted">{t("governing.empty")}</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="governing-documents">
                {content.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                    <a href={`/clubs/${clubId}/governing/${d.id}`} className="underline">
                      {d.name}
                    </a>
                    <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                      {t(enumKey("governing.statuses", d.governingStatus ?? "draft"))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {series.canManage ? (
              <details>
                <summary className="cursor-pointer text-sm underline">
                  {t("governing.newDocument")}
                </summary>
                <ActionForm
                  action="governing-create"
                  className="mt-2 space-y-2"
                  testId="new-governing"
                >
                  <input type="hidden" name="clubId" value={clubId} />
                  <input type="hidden" name="seriesId" value={s.id} />
                  <label className="block text-sm">
                    {t("governing.documentName")}
                    <input name="name" required maxLength={200} className={inputClass} />
                  </label>
                  <label className="block text-sm">
                    {t("governing.body")}
                    <textarea name="body" rows={8} className={inputClass} />
                    <span className="mt-1 block text-xs text-muted">{t("governing.bodyHelp")}</span>
                  </label>
                  <button type="submit" className={buttonClass}>
                    {t("governing.create")}
                  </button>
                </ActionForm>
              </details>
            ) : null}
          </section>
        );
      })}
      {series.canManage ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("governing.newSeries")}</h2>
          <ActionForm action="governing-create-series" className="space-y-2" testId="new-series">
            <input type="hidden" name="clubId" value={clubId} />
            <label className="block text-sm">
              {t("governing.seriesName")}
              <input name="name" required maxLength={120} className={inputClass} />
            </label>
            <label className="block text-sm">
              {t("governing.seriesKind")}
              <select name="seriesKind" className={inputClass} defaultValue="statutes">
                {SERIES_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(enumKey("governing.seriesKinds", k))}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass}>
              {t("governing.createSeries")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
