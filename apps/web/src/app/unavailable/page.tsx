// SPDX-License-Identifier: AGPL-3.0-only
// The session store (Valkey) cannot be reached (P1.14 finding 4): a readable
// page instead of an error (or, in development, Next.js's error overlay).
// Pages and the login redirect here; "Try again" goes back where they were.
// In development it says how to find and fix the cause.
import { getTranslations } from "next-intl/server";

import { webConfig } from "../../server/config.ts";
import { safeReturnTo } from "../../server/return-to.ts";

/** The commands that find and fix the cause in development (not translated: shell commands). */
const DEV_COMMANDS = "pnpm dev:doctor\ndocker restart clubadmin-valkey-1";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("errors.unavailable.title") };
}

export default async function UnavailablePage({ searchParams }: Props) {
  const [t, query] = await Promise.all([getTranslations(), searchParams]);
  const returnTo = safeReturnTo(typeof query.returnTo === "string" ? query.returnTo : "/");
  const development = webConfig().DEV_AUTH || process.env.NODE_ENV !== "production";
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-xl flex-1 space-y-4 px-4 py-16 text-center"
      data-testid="unavailable"
    >
      <h1 className="text-2xl font-semibold">{t("errors.unavailable.title")}</h1>
      <p className="text-muted">{t("errors.unavailable.text")}</p>
      {development ? (
        <div className="space-y-2 rounded-lg border border-border p-4 text-left text-sm">
          <p>{t("errors.unavailable.devHint")}</p>
          <pre className="overflow-x-auto rounded bg-accent-soft p-2 font-mono">{DEV_COMMANDS}</pre>
        </div>
      ) : null}
      <p>
        <a href={returnTo} className="text-accent underline" data-testid="unavailable-retry">
          {t("errors.unavailable.retry")}
        </a>
      </p>
    </main>
  );
}
