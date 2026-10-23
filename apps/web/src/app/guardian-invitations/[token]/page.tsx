// SPDX-License-Identifier: AGPL-3.0-only
// Landing page of a guardian invitation link (P1.3): who invites to what,
// then log in or sign up and accept. Expired, revoked and used links say so
// without revealing whom they were for. The token stays in the path; the API
// stores only its hash.
import { enumKey } from "@clubadmin/i18n";
import { isLinkedGuardianshipKind } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../components/action-form.tsx";
import { FormError } from "../../../components/form-error.tsx";
import { getSession, lookupGuardianInvitation } from "../../../server/data.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("family.landing.title"), robots: { index: false } };
}

export default async function GuardianInvitationPage({ params, searchParams }: Props) {
  const [{ token }, query, t, session] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getSession(),
  ]);
  const invitation =
    token.length >= 20 && token.length <= 200 ? await lookupGuardianInvitation(token) : null;
  const here = `/guardian-invitations/${encodeURIComponent(token)}`;
  return (
    <main id="main" className="mx-auto w-full max-w-lg flex-1 space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t("family.landing.title")}</h1>
      {invitation === null ? (
        <p role="alert" data-testid="guardian-invitation-invalid">
          {t("family.landing.invalid")}
        </p>
      ) : (
        <>
          <p data-testid="guardian-invitation">
            {t("family.landing.intro", {
              hasInviter: invitation.inviterName ? "yes" : "no",
              inviter: invitation.inviterName ?? "",
              hasWard: invitation.wardGivenName ? "yes" : "no",
              ward: invitation.wardGivenName ?? "",
              kind: t(enumKey("guardianKinds", invitation.kind)),
            })}
          </p>
          {isLinkedGuardianshipKind(invitation.kind) ? (
            <p className="text-sm">
              {t("family.landing.rights", {
                rights: invitation.rights.map((r) => t(enumKey("guardianRights", r))).join(", "),
              })}
            </p>
          ) : null}
          <p className="text-sm text-muted">{t("family.landing.email")}</p>
          <FormError code={query.error} />
          {session ? (
            <ActionForm action="accept-guardian-invitation" back={here}>
              <input type="hidden" name="token" value={token} />
              <button
                type="submit"
                className={buttonClass}
                data-testid="accept-guardian-invitation"
              >
                {t("family.landing.accept")}
              </button>
            </ActionForm>
          ) : (
            <div className="flex flex-wrap gap-2">
              <a
                href={`/login?returnTo=${encodeURIComponent(here)}`}
                className={buttonClass}
                data-testid="login-to-accept"
              >
                {t("family.landing.login")}
              </a>
            </div>
          )}
        </>
      )}
    </main>
  );
}
