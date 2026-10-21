// SPDX-License-Identifier: AGPL-3.0-only
// My account: who is logged in, with or without a second factor.

import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { LOGOUT_FORM } from "../../../components/app-frame.tsx";
import { getMe } from "../../../server/data.ts";

export async function generateMetadata() {
  return { title: (await getTranslations())("account.title") };
}

export default async function AccountPage() {
  const [t, me] = await Promise.all([getTranslations(), getMe()]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("account.title")}</h1>
      <p data-testid="me-name">{t("account.loggedInAs", { name: personLabel(me.person) })}</p>
      <p data-testid="me-mfa">{me.mfa ? t("account.mfa.on") : t("account.mfa.off")}</p>
      <ul className="list-inside list-disc">
        <li>
          <a href={`/people/${me.personId}`} className="text-accent underline">
            {t("userMenu.profile")}
          </a>
        </li>
        <li>
          <a href="/me/preferences" className="text-accent underline">
            {t("userMenu.language")}
          </a>
        </li>
        <li>
          <a href="/me/sessions" className="text-accent underline">
            {t("userMenu.sessions")}
          </a>
        </li>
      </ul>
      <button
        type="submit"
        form={LOGOUT_FORM}
        data-testid="logout"
        className="rounded-md border border-border px-3 py-1.5"
      >
        {t("userMenu.logout")}
      </button>
    </div>
  );
}
