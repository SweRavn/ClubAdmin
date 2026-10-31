// SPDX-License-Identifier: AGPL-3.0-only
// Language and time zone of the account (null: the club's, then the browser's).
// The time zone is a list with "The club's time zone" first (P1.6b).
import { enumKey } from "@clubadmin/i18n";
import { UI_LOCALES } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { TimeZoneSelect } from "../../../../components/time-zone-select.tsx";
import { getMe, requireSession } from "../../../../server/data.ts";

/** Errors of the save (each its own message, P1.6b). */
const ERRORS = ["timeZone", "locale", "rate_limited", "failed"] as const;

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
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2" data-testid="form-error">
          {t(`preferences.errors.${ERRORS.find((e) => e === params.error) ?? "failed"}`)}
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
                {t(enumKey("locales", l))}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="timeZone" className="block font-medium">
            {t("preferences.timeZone")}
          </label>
          <TimeZoneSelect
            id="timeZone"
            name="timeZone"
            value={timeZone}
            clubOption={t("preferences.clubTimeZone")}
            testId="preferences-timeZone"
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
