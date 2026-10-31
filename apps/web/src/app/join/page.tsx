// SPDX-License-Identifier: AGPL-3.0-only
// Joining with a code (P1.6b), public: a code field (or /join?code=XXXX
// from a link), the club it is for, then log in or sign up, complete the
// profile and accept; the code stays in the return path throughout.
import { getTranslations } from "next-intl/server";

import { buttonClass, inputClass } from "../../components/action-form.tsx";
import { FormError } from "../../components/form-error.tsx";
import { JoinActions } from "../../components/join-actions.tsx";
import { lookupInvitation } from "../../server/data.ts";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("joinCode.title"), robots: { index: false } };
}

/** Codes as people type them: upper case, without spaces and dashes. */
const normalized = (code: string) => code.toUpperCase().replace(/[\s-]/g, "").slice(0, 32);

export default async function JoinWithCodePage({ searchParams }: Props) {
  const [query, t] = await Promise.all([searchParams, getTranslations()]);
  const code = typeof query.code === "string" ? normalized(query.code) : "";
  const invitation = code ? await lookupInvitation(code, "code") : null;
  const here = `/join?code=${encodeURIComponent(code)}`;
  return (
    <main id="main" className="mx-auto w-full max-w-lg flex-1 space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">
        {invitation ? t("joinLanding.title", { club: invitation.clubName }) : t("joinCode.title")}
      </h1>
      {invitation ? (
        <>
          <p data-testid="invitation-club">
            {t("joinLanding.intro", { club: invitation.clubName })}
          </p>
          <FormError code={query.error} />
          <JoinActions clubName={invitation.clubName} here={here} secret={{ code }} />
        </>
      ) : (
        <>
          <p>{t("joinCode.intro")}</p>
          {code ? (
            <p role="alert" data-testid="invitation-invalid">
              {t("joinLanding.invalid")}
            </p>
          ) : null}
          <form method="get" action="/join" className="space-y-2" data-testid="join-code-form">
            <label className="block space-y-1">
              <span className="text-sm">{t("onboarding.code")}</span>
              <input
                name="code"
                required
                defaultValue={code}
                autoComplete="off"
                autoCapitalize="characters"
                className={inputClass}
                data-testid="join-code"
              />
            </label>
            <button type="submit" className={buttonClass} data-testid="join-code-submit">
              {t("joinCode.lookUp")}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
