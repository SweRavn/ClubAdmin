// SPDX-License-Identifier: AGPL-3.0-only
// The club's storage (P2.2, ADR 0049 decision 6): what the files use, the
// operator's limit, and the club's own limits for the club and per group.
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { formatSize } from "../../../../../components/documents.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getClub, getStorage } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const MB = 1024 * 1024;
const mb = (bytes: number | null) => (bytes === null ? "" : String(Math.round(bytes / MB)));

export async function generateMetadata() {
  return { title: (await getTranslations())("documents.storage.title") };
}

export default async function StoragePage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, storage] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getStorage(clubId),
  ]);
  const share = Math.min(
    100,
    Math.round((storage.usedBytes / Math.max(1, storage.limitBytes)) * 100),
  );
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}/documents`} className="underline">
            {t("documents.title")}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("documents.storage.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("documents.storage.intro")}</p>
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("documents.saved")}</Notice> : null}
      <div className="space-y-1" data-testid="storage-used">
        <p className="text-sm">
          {t("documents.storage.used", {
            used: formatSize(storage.usedBytes, locale),
            limit: formatSize(storage.limitBytes, locale),
          })}
        </p>
        <div
          className="h-2 w-full max-w-md overflow-hidden rounded bg-border"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
        >
          <div className="h-full bg-accent" style={{ width: `${share}%` }} />
        </div>
        <p className="text-xs text-muted">
          {t("documents.storage.operator", {
            limit: formatSize(storage.operatorLimitBytes, locale),
          })}
        </p>
      </div>
      <ActionForm action="documents-storage" className="space-y-4" testId="storage-form">
        <input type="hidden" name="clubId" value={club.id} />
        <label className="block text-sm">
          {t("documents.storage.clubLimit")}
          <input
            name="clubLimitMb"
            inputMode="numeric"
            defaultValue={mb(storage.clubLimitBytes)}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-muted">{t("documents.storage.limitHelp")}</span>
        </label>
        {storage.groups.length > 0 ? (
          <table className="w-full max-w-xl text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-normal">{t("documents.storage.group")}</th>
                <th className="py-1 font-normal">{t("documents.storage.groupUsed")}</th>
                <th className="py-1 font-normal">{t("documents.storage.groupLimit")}</th>
              </tr>
            </thead>
            <tbody>
              {storage.groups.map((g) => (
                <tr key={g.groupId} className="border-t border-border">
                  <td className="py-1">{g.groupName}</td>
                  <td className="py-1">{formatSize(g.usedBytes, locale)}</td>
                  <td className="py-1">
                    <input type="hidden" name="groupId" value={g.groupId} />
                    <input
                      name={`groupLimitMb.${g.groupId}`}
                      inputMode="numeric"
                      aria-label={t("documents.storage.groupLimitFor", { group: g.groupName })}
                      defaultValue={mb(g.limitBytes)}
                      className={inputClass}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <button type="submit" className={buttonClass}>
          {t("documents.save")}
        </button>
      </ActionForm>
    </div>
  );
}
