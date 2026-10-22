// SPDX-License-Identifier: AGPL-3.0-only
// Landing page of an invitation link (P1.1): which club it is for, then log
// in or sign up and accept. The token stays in the path; the API stores only
// its hash.
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../components/action-form.tsx";
import { FormError } from "../../../components/form-error.tsx";
import { getSession, lookupInvitation } from "../../../server/data.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("invitations.title"), robots: { index: false } };
}

export default async function JoinPage({ params, searchParams }: Props) {
  const [{ token }, query, t, session] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getSession(),
  ]);
  const invitation = token.length <= 100 ? await lookupInvitation(token) : null;
  const here = `/join/${encodeURIComponent(token)}`;
  return (
    <main id="main" className="mx-auto w-full max-w-lg flex-1 space-y-4 px-4 py-8">
      {invitation === null ? (
        <>
          <h1 className="text-2xl font-semibold">{t("invitations.title")}</h1>
          <p role="alert" data-testid="invitation-invalid">
            {t("joinLanding.invalid")}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold" data-testid="invitation-club">
            {t("joinLanding.title", { club: invitation.clubName })}
          </h1>
          <p>{t("joinLanding.intro", { club: invitation.clubName })}</p>
          <FormError code={query.error} />
          {session ? (
            <ActionForm action="accept-invitation" back={here}>
              <input type="hidden" name="token" value={token} />
              <button type="submit" className={buttonClass} data-testid="accept-invitation">
                {t("joinLanding.accept", { club: invitation.clubName })}
              </button>
            </ActionForm>
          ) : (
            <a
              href={`/login?returnTo=${encodeURIComponent(here)}`}
              className={buttonClass}
              data-testid="login-to-accept"
            >
              {t("joinLanding.login")}
            </a>
          )}
        </>
      )}
    </main>
  );
}
