// SPDX-License-Identifier: AGPL-3.0-only
// What someone does with an invitation they looked up (P1.1, P1.6b): log
// in or sign up (coming back here), complete the profile (coming back
// here), then accept. The link token or code stays in `here`.
import { getTranslations } from "next-intl/server";

import { getMyProfile, getSession } from "../server/data.ts";
import { ActionForm, buttonClass } from "./action-form.tsx";

export async function JoinActions({
  clubName,
  here,
  secret,
}: {
  clubName: string;
  /** This page, with the token or code. */
  here: string;
  secret: { token: string } | { code: string };
}) {
  const [t, session] = await Promise.all([getTranslations(), getSession()]);
  if (!session) {
    return (
      <a
        href={`/login?returnTo=${encodeURIComponent(here)}`}
        className={buttonClass}
        data-testid="login-to-accept"
      >
        {t("joinLanding.login")}
      </a>
    );
  }
  const profile = await getMyProfile();
  if (!profile.complete) {
    return (
      <div className="space-y-2">
        <p>{t("joinLanding.completeProfile")}</p>
        <a
          href={`/me/profile?next=${encodeURIComponent(here)}`}
          className={buttonClass}
          data-testid="complete-profile-to-accept"
        >
          {t("profileForm.title")}
        </a>
      </div>
    );
  }
  return (
    <ActionForm action="accept-invitation" back={here}>
      {"token" in secret ? (
        <input type="hidden" name="token" value={secret.token} />
      ) : (
        <input type="hidden" name="code" value={secret.code} />
      )}
      <button type="submit" className={buttonClass} data-testid="accept-invitation">
        {t("joinLanding.accept", { club: clubName })}
      </button>
    </ActionForm>
  );
}
