// SPDX-License-Identifier: AGPL-3.0-only
// Placeholder home page; the app shell comes in P0.9.
import { translator } from "./i18n.ts";

export default async function Home() {
  const { t } = await translator();
  return (
    <main>
      <h1>{t("web.title")}</h1>
      <p>{t("web.home.intro")}</p>
      <p>
        <a href="/auth/login">{t("web.home.login")}</a> · <a href="/me">{t("web.home.me")}</a>
      </p>
    </main>
  );
}
