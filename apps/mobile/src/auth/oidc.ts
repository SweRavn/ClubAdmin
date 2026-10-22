// SPDX-License-Identifier: AGPL-3.0-only
// Login with Zitadel: authorization code + PKCE in the system browser
// (ASWebAuthenticationSession / Custom Tabs), refresh with rotation,
// revocation and ending the identity-provider session at logout.

import {
  AuthRequest,
  type DiscoveryDocument,
  exchangeCodeAsync,
  fetchDiscoveryAsync,
  makeRedirectUri,
  refreshAsync,
  ResponseType,
  revokeAsync,
  TokenError,
  type TokenResponse,
  TokenTypeHint,
} from "expo-auth-session";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";

import { appConfig } from "../config.ts";
import { LoginEndedError, type TokenSet } from "./tokens.ts";

let discovery: Promise<DiscoveryDocument> | null = null;
function discover(): Promise<DiscoveryDocument> {
  discovery ??= fetchDiscoveryAsync(appConfig.authIssuer).catch((error: unknown) => {
    discovery = null;
    throw error;
  });
  return discovery;
}

const scheme = () => {
  const value = Constants.expoConfig?.scheme;
  return (Array.isArray(value) ? value[0] : value) ?? "clubadmin";
};

export const redirectUri = () => makeRedirectUri({ scheme: scheme(), path: "auth/callback" });
export const postLogoutRedirectUri = () =>
  makeRedirectUri({ scheme: scheme(), path: "auth/logout" });

/** Scopes as the web app asks for them: identity, a refresh token, the project as audience. */
export function scopes(projectId: string): string[] {
  const base = ["openid", "profile", "email", "offline_access"];
  return projectId ? [...base, `urn:zitadel:iam:org:project:id:${projectId}:aud`] : base;
}

export function tokenSetOf(response: TokenResponse, now = Date.now()): TokenSet {
  return {
    accessToken: response.accessToken,
    idToken: response.idToken ?? null,
    expiresAt: now + (response.expiresIn ?? 600) * 1000,
  };
}

export type SignInResult =
  { kind: "success"; tokens: TokenSet; refreshToken: string } | { kind: "cancelled" };

export async function signInWithZitadel(): Promise<SignInResult> {
  const doc = await discover();
  const request = new AuthRequest({
    clientId: appConfig.authClientId,
    redirectUri: redirectUri(),
    scopes: scopes(appConfig.authProjectId),
    responseType: ResponseType.Code,
    usePKCE: true,
  });
  const result = await request.promptAsync(doc);
  if (result.type !== "success") {
    if (result.type === "error") throw result.error ?? new Error("login failed");
    return { kind: "cancelled" };
  }
  const response = await exchangeCodeAsync(
    {
      clientId: appConfig.authClientId,
      code: result.params.code ?? "",
      redirectUri: redirectUri(),
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
    },
    doc,
  );
  if (!response.refreshToken) throw new Error("no refresh token (offline_access)");
  return { kind: "success", tokens: tokenSetOf(response), refreshToken: response.refreshToken };
}

export async function refreshWithZitadel(
  refreshToken: string,
): Promise<{ tokens: TokenSet; refreshToken: string | null }> {
  const doc = await discover();
  try {
    const response = await refreshAsync(
      { clientId: appConfig.authClientId, refreshToken, scopes: scopes(appConfig.authProjectId) },
      doc,
    );
    return { tokens: tokenSetOf(response), refreshToken: response.refreshToken ?? null };
  } catch (error) {
    // invalid_grant: revoked (session ended in /me/sessions), expired or already used.
    if (error instanceof TokenError && error.code === "invalid_grant") throw new LoginEndedError();
    throw error;
  }
}

/** Logout at Zitadel: revoke the refresh token and end the browser session. Best effort. */
export async function signOutOfZitadel(refreshToken: string | null, idTokenHint: string | null) {
  const doc = await discover().catch(() => null);
  if (!doc) return;
  if (refreshToken && doc.revocationEndpoint) {
    await revokeAsync(
      {
        token: refreshToken,
        clientId: appConfig.authClientId,
        tokenTypeHint: TokenTypeHint.RefreshToken,
      },
      doc,
    ).catch(() => undefined);
  }
  if (doc.endSessionEndpoint) {
    const url = new URL(doc.endSessionEndpoint);
    url.searchParams.set("client_id", appConfig.authClientId);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri());
    if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
    await WebBrowser.openAuthSessionAsync(url.toString(), postLogoutRedirectUri()).catch(
      () => undefined,
    );
  }
}
