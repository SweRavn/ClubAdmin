// SPDX-License-Identifier: AGPL-3.0-only
// Zitadel redirects here with the authorization code. The code is exchanged
// (checking state, nonce and PKCE), the API is called once to resolve (or
// create) the person, and a new session is created: a fresh session ID on
// every login, so a planted (fixated) cookie is never reused.

import { ACCOUNT_INVITATION_HEADER, MeResponseSchema } from "@clubadmin/shared";
import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { webConfig } from "../../../server/config.ts";
import { FLOW_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { describeDevice } from "../../../server/device.ts";
import { redirectTo, setSessionCookies, siteUrl } from "../../../server/http.ts";
import { client, oidcClient } from "../../../server/oidc.ts";
import { allowAuthRequest, clientIp } from "../../../server/rate-limit.ts";
import { createSession, endSession, loadSession } from "../../../server/sessions.ts";
import { valkey } from "../../../server/valkey.ts";
import { flowKey, type LoginFlow } from "../login/start/route.ts";

export const dynamic = "force-dynamic";

const failed = (reason: string) => {
  const response = redirectTo(`/login?error=${encodeURIComponent(reason)}`);
  response.cookies.delete({ name: FLOW_COOKIE, path: "/", secure: true });
  return response;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  if (!(await allowAuthRequest(clientIp(request.headers), config.AUTH_RATE_LIMIT_MAX)))
    return failed("rate_limited");
  const state = request.nextUrl.searchParams.get("state");
  if (!state || request.cookies.get(FLOW_COOKIE)?.value !== state) return failed("state");
  const raw = await valkey().getdel(flowKey(state));
  if (!raw) return failed("expired");
  const flow = JSON.parse(raw) as LoginFlow;

  let tokens;
  try {
    // The URL Zitadel redirected to, as the browser saw it (not the internal one).
    const callbackUrl = new URL(siteUrl(`/auth/callback${request.nextUrl.search}`));
    tokens = await client.authorizationCodeGrant(await oidcClient(config), callbackUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
  } catch {
    return failed("token");
  }

  const apiTokens = { accessToken: tokens.access_token, idToken: tokens.id_token ?? null };
  const me = await apiFetch("/api/v1/me", apiTokens, {
    headers: flow.invitation ? { [ACCOUNT_INVITATION_HEADER]: flow.invitation } : {},
  });
  if (!me.ok) {
    const detail = ((await me.json().catch(() => ({}))) as { detail?: string }).detail;
    // e.g. email_taken: the address belongs to another account (no merge by email).
    return failed(detail ?? `api_${me.status}`);
  }
  const { personId } = MeResponseSchema.parse(await me.json());

  // Replace any session this browser had before.
  const previous = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (previous) await endSession(previous);

  const session = await createSession({
    personId,
    accessToken: tokens.access_token,
    idToken: tokens.id_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: Date.now() + (tokens.expiresIn() ?? 60) * 1000,
    idpSessionId:
      typeof tokens.claims()?.sid === "string" ? (tokens.claims()!.sid as string) : null,
    devAuth: false,
    device: describeDevice(request.headers.get("user-agent")),
  });
  const response = NextResponse.redirect(siteUrl(flow.returnTo), 303);
  setSessionCookies(response, session);
  return response;
}
