// SPDX-License-Identifier: AGPL-3.0-only
// The unsubscribe link of notification emails (P1.7): one button turns off
// email for that category, without logging in. Mail clients' one-click
// unsubscribe (RFC 8058) posts to the API directly; this page is for people.
// The token is checked when the button is pressed; the page only shows
// which category the link is for.
import { enumKey } from "@clubadmin/i18n";
import { NOTIFICATION_CATEGORIES } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { buttonClass } from "../../components/action-form.tsx";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return {
    title: (await getTranslations())("notifications.unsubscribe.title"),
    robots: { index: false },
  };
}

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");
const categoryOf = (value: string) =>
  (NOTIFICATION_CATEGORIES as readonly string[]).includes(value) ? value : null;

export default async function UnsubscribePage({ searchParams }: Props) {
  const [query, t] = await Promise.all([searchParams, getTranslations()]);
  const token = one(query.token);
  const done = categoryOf(one(query.done));
  const error = one(query.error);
  const category = categoryOf(token.split(".")[1] ?? "");
  const valid = token.length >= 20 && token.length <= 300 && category !== null;
  const name = (c: string) => t(enumKey("notifyCategories", c));
  return (
    <main id="main" className="mx-auto w-full max-w-lg flex-1 space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t("notifications.unsubscribe.title")}</h1>
      {done ? (
        <p role="status" data-testid="unsubscribe-done">
          {t("notifications.unsubscribe.done", { category: name(done) })}
        </p>
      ) : error === "notification_mandatory" ? (
        <p role="alert">{t("notifications.unsubscribe.mandatory")}</p>
      ) : !valid || error ? (
        <p role="alert" data-testid="unsubscribe-invalid">
          {t("notifications.unsubscribe.invalid")}
        </p>
      ) : (
        <form method="post" action="/unsubscribe/confirm" className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <p>{t("notifications.unsubscribe.intro", { category: name(category) })}</p>
          <button type="submit" className={buttonClass} data-testid="unsubscribe-confirm">
            {t("notifications.unsubscribe.confirm")}
          </button>
        </form>
      )}
      <p>
        <a href="/me/notifications/settings" className="underline">
          {t("notifications.unsubscribe.settings")}
        </a>
      </p>
    </main>
  );
}
