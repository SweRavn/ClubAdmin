// SPDX-License-Identifier: AGPL-3.0-only
// Language and time zone of the account (null: the club's, then the browser's).

import { UI_LOCALES } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { getMe, requireSession } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("preferences.title") };
}

export default async function PreferencesPage({ searchParams }: Props) {
  const [t, me, session, params] = await Promise.all([
    getTranslations(),
    getMe(),
    requireSession(),
    searchParams,
  ]);
  const { locale, timeZone } = me.preferences;
  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold">{t("preferences.title")}</h1>
      {params.saved ? (
        <p role="status" className="rounded-md bg-accent-soft px-3 py-2">
          {t("preferences.saved")}
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {t("preferences.invalidTimeZone")}
        </p>
      ) : null}
      <form method="post" action="/me/preferences/save" className="space-y-4">
        <input type="hidden" name="csrf" value={session.record.csrf} />
        <div className="space-y-1">
          <label htmlFor="locale" className="block font-medium">
            {t("preferences.language")}
          </label>
          <select
            id="locale"
            name="locale"
            defaultValue={locale ?? ""}
            className="w-full rounded-md border border-border bg-bg px-3 py-2"
          >
            <option value="">{t("preferences.automatic")}</option>
            {UI_LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {t(`locales.${l}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="timeZone" className="block font-medium">
            {t("preferences.timeZone")}
          </label>
          <input
            id="timeZone"
            name="timeZone"
            defaultValue={timeZone ?? ""}
            aria-describedby="timeZone-hint"
            autoComplete="off"
            className="w-full rounded-md border border-border bg-bg px-3 py-2"
          />
          <p id="timeZone-hint" className="text-sm text-muted">
            {t("preferences.timeZoneHint")}
          </p>
        </div>
        <button type="submit" className="rounded-md bg-accent px-4 py-2 text-accent-fg">
          {t("common.save")}
        </button>
      </form>
    </div>
  );
}
