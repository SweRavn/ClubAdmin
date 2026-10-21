// SPDX-License-Identifier: AGPL-3.0-only
// Starts the real login: authorization code + PKCE with Zitadel. The flow
// (verifier, nonce, return path, invitation) waits in Valkey under the state,
// and a cookie binds it to this browser.

import { negotiateLocale } from "@clubadmin/i18n";
import { type NextRequest, NextResponse } from "next/server";

import { oidcConfigured, webConfig } from "../../../../server/config.ts";
import { FLOW_COOKIE, flowCookieOptions } from "../../../../server/cookies.ts";
import { redirectTo } from "../../../../server/http.ts";
import { client, oidcClient, redirectUri, scopes } from "../../../../server/oidc.ts";
import { allowAuthRequest, clientIp } from "../../../../server/rate-limit.ts";
import { safeReturnTo } from "../../../../server/return-to.ts";
import { valkey } from "../../../../server/valkey.ts";

export const dynamic = "force-dynamic";

export interface LoginFlow {
  verifier: string;
  nonce: string;
  returnTo: string;
  invitation: string | null;
}

export const flowKey = (state: string) => `bff:auth-flow:${state}`;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  if (!oidcConfigured(config)) return redirectTo("/auth/login?error=not_configured");
  if (!(await allowAuthRequest(clientIp(request.headers), config.AUTH_RATE_LIMIT_MAX))) {
    return redirectTo("/auth/login?error=rate_limited");
  }
  const params = request.nextUrl.searchParams;
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const flow: LoginFlow = {
    verifier,
    nonce: client.randomNonce(),
    returnTo: safeReturnTo(params.get("returnTo")),
    invitation: params.get("invitation")?.slice(0, 200) ?? null,
  };
  await valkey().set(flowKey(state), JSON.stringify(flow), "EX", 600);

  const url = client.buildAuthorizationUrl(await oidcClient(config), {
    redirect_uri: redirectUri(config),
    scope: scopes(config),
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce: flow.nonce,
    ui_locales: negotiateLocale(request.headers.get("accept-language") ?? undefined),
    // Zitadel shows its registration form directly.
    ...(params.get("signup") === "1" ? { prompt: "create" } : {}),
  });
  const response = NextResponse.redirect(url.toString(), 303);
  response.cookies.set(FLOW_COOKIE, state, flowCookieOptions);
  return response;
}
