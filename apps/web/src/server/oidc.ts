// SPDX-License-Identifier: AGPL-3.0-only
// OpenID Connect with Zitadel: authorization code + PKCE (openid-client),
// confidential client (the BFF holds the client secret). The configuration
// is discovered once per process.

import * as client from "openid-client";

import { type WebConfig, webConfig } from "./config.ts";

let discovered: Promise<client.Configuration> | undefined;

export function oidcClient(config: WebConfig = webConfig()): Promise<client.Configuration> {
  if (!config.AUTH_ISSUER || !config.AUTH_WEB_CLIENT_ID || !config.AUTH_WEB_CLIENT_SECRET) {
    throw new Error("OIDC is not configured: run pnpm auth:configure");
  }
  discovered ??= client
    .discovery(
      new URL(config.AUTH_ISSUER),
      config.AUTH_WEB_CLIENT_ID,
      config.AUTH_WEB_CLIENT_SECRET,
    )
    .catch((error: unknown) => {
      discovered = undefined;
      throw error;
    });
  return discovered;
}

/** Scopes: identity, email and profile, a refresh token, and the project as access-token audience. */
export function scopes(config: WebConfig = webConfig()): string {
  const project = config.AUTH_PROJECT_ID
    ? ` urn:zitadel:iam:org:project:id:${config.AUTH_PROJECT_ID}:aud`
    : "";
  return `openid profile email offline_access${project}`;
}

export const redirectUri = (config: WebConfig = webConfig()) =>
  `${config.PUBLIC_WEB_URL.replace(/\/$/, "")}/auth/callback`;

export { client };
