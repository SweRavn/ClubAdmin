// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH persona login (form on /login). Exists only when DEV_AUTH is
// on, which the server refuses outside development.

import { DEV_TOKEN_SECONDS, mintDevToken } from "@clubadmin/server-kit/dev-tokens";
import { isUuid, MeResponseSchema } from "@clubadmin/shared";
import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { webConfig } from "../../../server/config.ts";
import { SESSION_COOKIE } from "../../../server/cookies.ts";
import { isSameOrigin } from "../../../server/csrf.ts";
import { describeDevice } from "../../../server/device.ts";
import {
  formText,
  problem,
  redirectTo,
  setSessionCookies,
  siteOrigin,
  siteUrl,
} from "../../../server/http.ts";
import { allowAuthRequest, clientIp } from "../../../server/rate-limit.ts";
import { safeReturnTo } from "../../../server/return-to.ts";
import { newSessionHandle } from "../../../server/session-store.ts";
import { createSession, endSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  if (!config.DEV_AUTH || !config.DEV_AUTH_KEY) return problem("not-found");
  // Login CSRF: only forms from this site.
  if (!isSameOrigin(request.headers.get("origin"), siteOrigin())) return problem("forbidden");
  if (!(await allowAuthRequest(clientIp(request.headers), config.AUTH_RATE_LIMIT_MAX))) {
    return redirectTo("/login?error=rate_limited");
  }
  const form = await request.formData();
  const personId = formText(form, "personId");
  if (!isUuid(personId)) return redirectTo("/login?error=person");
  const mfa = form.get("mfa") === "1";

  const handle = newSessionHandle();
  const accessToken = await mintDevToken(config.DEV_AUTH_KEY, personId, { mfa, sessionId: handle });
  const me = await apiFetch("/api/v1/me", { accessToken, idToken: null });
  if (!me.ok) return redirectTo("/login?error=person");
  MeResponseSchema.parse(await me.json());

  const previous = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (previous) await endSession(previous);
  const session = await createSession(
    {
      personId,
      accessToken,
      idToken: null,
      refreshToken: null,
      expiresAt: Date.now() + DEV_TOKEN_SECONDS * 1000,
      idpSessionId: null,
      devAuth: true,
      devMfa: mfa,
      device: describeDevice(request.headers.get("user-agent")),
    },
    { handle },
  );
  const response = NextResponse.redirect(siteUrl(safeReturnTo(formText(form, "returnTo"))), 303);
  setSessionCookies(response, session);
  return response;
}
