// SPDX-License-Identifier: AGPL-3.0-only
// The app's API client: the generated typed client (packages/api-client)
// over a fetch that adds the tokens (ADR 0024), the guardian's ward where it
// applies (X-On-Behalf-Of, onBehalfApplies), the language, and the app's
// platform and version for the session list. A 401 triggers one token
// refresh and one retry; a second 401 means the session was revoked.

import { type ApiClient, createApiClient, onBehalfApplies } from "@clubadmin/api-client";
import {
  CLIENT_DEVICE_HEADER,
  CLIENT_PLATFORM_HEADER,
  CLIENT_VERSION_HEADER,
  ID_TOKEN_HEADER,
  ON_BEHALF_OF_HEADER,
} from "@clubadmin/shared";
import { randomUUID } from "expo-crypto";

import type { TokenSet } from "../auth/tokens.ts";

export interface RequestContext {
  /** A valid token set (refreshed when needed); null when signed out. */
  tokens: () => Promise<TokenSet | null>;
  /** Forces a refresh after a 401. */
  renew: () => Promise<TokenSet>;
  /** A 401 even with fresh tokens: the session was revoked (ADR 0028); log out. */
  loginEnded: () => void;
  /** The ward the guardian is viewing as, if any. */
  onBehalfOf: () => string | null;
  /** Preferred languages, e.g. "sv, en". */
  acceptLanguage: () => string;
  client: { platform: string; version: string; device: string };
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

export function authorizedFetch(context: RequestContext, base: typeof fetch = fetch): typeof fetch {
  const send = async (request: Request, tokens: TokenSet | null): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.set("accept-language", context.acceptLanguage());
    headers.set(CLIENT_PLATFORM_HEADER, context.client.platform);
    headers.set(CLIENT_VERSION_HEADER, context.client.version);
    headers.set(CLIENT_DEVICE_HEADER, context.client.device);
    if (tokens) {
      headers.set("authorization", `Bearer ${tokens.accessToken}`);
      if (tokens.idToken) headers.set(ID_TOKEN_HEADER, tokens.idToken);
      const ward = context.onBehalfOf();
      if (ward && onBehalfApplies(pathOf(request.url))) headers.set(ON_BEHALF_OF_HEADER, ward);
    }
    return base(new Request(request, { headers }));
  };

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof URL ? input.toString() : input, init);
    const retryCopy = request.clone();
    const tokens = await context.tokens();
    const response = await send(request, tokens);
    if (response.status !== 401 || !tokens) return response;
    // The access token was refused (expired early, or the session was revoked).
    const renewed = await context.renew();
    const retried = await send(retryCopy, renewed);
    if (retried.status === 401) context.loginEnded();
    return retried;
  };
}

export function createAppApiClient(
  baseUrl: string,
  context: RequestContext,
  base: typeof fetch = fetch,
): ApiClient {
  // Hermes has no Web Crypto (globalThis.crypto): request IDs come from expo-crypto.
  return createApiClient({ baseUrl, fetch: authorizedFetch(context, base), requestId: randomUUID });
}
