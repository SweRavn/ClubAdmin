// SPDX-License-Identifier: AGPL-3.0-only
// My account: who is logged in, with or without a second factor; what is
// in progress (waiting lists, join requests; P1.6b) and joining another
// club with a code.

import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { LOGOUT_FORM } from "../../../components/app-frame.tsx";
import { InProgress } from "../../../components/joining-panels.tsx";
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
          <a href="/me/family" className="text-accent underline" data-testid="me-family">
            {t("family.title")}
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
      <Suspense fallback={null}>
        <InProgress />
      </Suspense>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("joinCode.title")}</h2>
        <form method="get" action="/join" className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1">
            <span className="text-sm">{t("onboarding.code")}</span>
            <input
              name="code"
              required
              autoComplete="off"
              autoCapitalize="characters"
              className="rounded-md border border-border bg-bg px-3 py-2"
              data-testid="me-join-code"
            />
          </label>
          <button type="submit" className="rounded-md border border-border px-3 py-2">
            {t("joinCode.lookUp")}
          </button>
        </form>
      </section>
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
