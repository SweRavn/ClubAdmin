// SPDX-License-Identifier: AGPL-3.0-only
// Notification settings (P1.7): per category, email (always, only without
// the app, never) and push; quiet hours for push; whether push shows the
// text on the lock screen; the phones that get push. Emails that cannot be
// turned off (security notices, managers changed, member exports) say so.

import { enumKey } from "@clubadmin/i18n";
import { EMAIL_MODES } from "@clubadmin/shared";
import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getNotificationSettings, getPushDevices } from "../../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("notifications.settings.title") };
}

export default async function NotificationSettingsPage({ searchParams }: Props) {
  const [t, locale, timeZone, query, settings, devices] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    searchParams,
    getNotificationSettings(),
    getPushDevices(),
  ]);
  const push = settings.channels.includes("push");
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("notifications.settings.title")}</h1>
      <p className="text-sm text-muted">{t("notifications.settings.intro")}</p>
      {query.saved ? <Notice>{t("notifications.settings.saved")}</Notice> : null}
      {query.deleted ? <Notice>{t("notifications.settings.deviceRemoved")}</Notice> : null}
      <FormError code={query.error} />
      <ActionForm
        action="save-notification-settings"
        className="space-y-6"
        testId="notification-settings"
      >
        <input
          type="hidden"
          name="categories"
          value={settings.categories.map((c) => c.category).join(",")}
        />
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th scope="col" className="py-2">
                {t("notifications.settings.category")}
              </th>
              <th scope="col" className="py-2">
                {t("notifications.settings.email")}
              </th>
              {push ? (
                <th scope="col" className="py-2">
                  {t("notifications.settings.push")}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {settings.categories.map((c) => (
              <tr key={c.category} data-category={c.category}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="block font-medium">
                    {t(enumKey("notifyCategories", c.category))}
                  </span>
                  {c.emailMandatory ? (
                    <span className="block text-xs text-muted">
                      {t("notifications.settings.mandatory")}
                    </span>
                  ) : null}
                </th>
                <td className="py-2 pr-3">
                  <select
                    name={`email.${c.category}`}
                    defaultValue={c.email}
                    aria-label={t("notifications.settings.emailFor", {
                      category: t(enumKey("notifyCategories", c.category)),
                    })}
                    data-testid={`email-${c.category}`}
                    className="rounded-md border border-border bg-bg px-2 py-1"
                  >
                    {EMAIL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(enumKey("notifications.emailModes", mode))}
                      </option>
                    ))}
                  </select>
                </td>
                {push ? (
                  <td className="py-2">
                    <input
                      type="checkbox"
                      name={`push.${c.category}`}
                      defaultChecked={c.push}
                      aria-label={t("notifications.settings.pushFor", {
                        category: t(enumKey("notifyCategories", c.category)),
                      })}
                    />
                  </td>
                ) : (
                  // Kept as it is when this server has no push.
                  <td hidden>
                    {c.push ? <input type="hidden" name={`push.${c.category}`} value="on" /> : null}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <fieldset className="space-y-2">
          <legend className="font-medium">{t("notifications.settings.quietHours")}</legend>
          <p className="text-sm text-muted">{t("notifications.settings.quietHint")}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="quiet" defaultChecked={settings.quietHours !== null} />
            {t("notifications.settings.quietOn")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              {t("notifications.settings.from")}
              <input
                type="time"
                name="quietFrom"
                defaultValue={settings.quietHours?.from ?? "21:00"}
                className="rounded-md border border-border bg-bg px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-1">
              {t("notifications.settings.to")}
              <input
                type="time"
                name="quietTo"
                defaultValue={settings.quietHours?.to ?? "07:00"}
                className="rounded-md border border-border bg-bg px-2 py-1"
              />
            </label>
          </div>
        </fieldset>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="pushPreview" defaultChecked={settings.pushPreview} />
          {t("notifications.settings.pushPreview")}
        </label>
        <p className="text-sm text-muted">{t("notifications.settings.digestHint")}</p>
        <button type="submit" className={buttonClass} data-testid="save-notification-settings">
          {t("common.save")}
        </button>
      </ActionForm>
      {push ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("notifications.settings.devices")}</h2>
          {devices.items.length === 0 ? (
            <p className="text-sm text-muted">{t("notifications.settings.noDevices")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
              {devices.items.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                  <span>{t(enumKey("notifications.platforms", d.platform))}</span>
                  <span className="text-muted">
                    {t("notifications.settings.lastSeen", {
                      time: formatDateTime(d.lastSeenAt, { locale, timeZone }),
                    })}
                  </span>
                  <ActionForm action="remove-push-device" className="ml-auto">
                    <input type="hidden" name="deviceId" value={d.id} />
                    <button type="submit" className="rounded-md border border-border px-3 py-1">
                      {t("notifications.settings.removeDevice")}
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
