// SPDX-License-Identifier: AGPL-3.0-only
// Logout (POST with the CSRF token): removes the session in Valkey, revokes
// the refresh token and ends the Zitadel session via its end-session page.

import { type NextRequest, NextResponse } from "next/server";

import { webConfig } from "../../../server/config.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf } from "../../../server/csrf.ts";
import {
  clearSessionCookies,
  formText,
  problem,
  siteOrigin,
  siteUrl,
} from "../../../server/http.ts";
import { client, oidcClient } from "../../../server/oidc.ts";
import { endSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  const form = await request.formData();
  if (
    session &&
    !checkCsrf({
      method: "POST",
      origin: request.headers.get("origin"),
      expectedOrigin: siteOrigin(),
      submitted: formText(form, "csrf") || request.headers.get("x-csrf-token"),
      cookie: request.cookies.get(CSRF_COOKIE)?.value ?? null,
      session: session.record.csrf,
    })
  ) {
    return problem("forbidden", "csrf");
  }

  let target = siteUrl("/");
  if (session) {
    await endSession(session);
    if (!session.record.devAuth && session.record.idToken && webConfig().AUTH_ISSUER) {
      try {
        target = client
          .buildEndSessionUrl(await oidcClient(), {
            id_token_hint: session.record.idToken,
            post_logout_redirect_uri: siteUrl("/"),
          })
          .toString();
      } catch {
        // No end-session endpoint: the local logout is done.
      }
    }
  }
  const response = NextResponse.redirect(target, 303);
  clearSessionCookies(response);
  return response;
}
