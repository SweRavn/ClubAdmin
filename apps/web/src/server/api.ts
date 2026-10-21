// SPDX-License-Identifier: AGPL-3.0-only
// Server-to-server calls from the BFF to the API with the session's tokens.

import { ID_TOKEN_HEADER } from "@clubadmin/shared";

import { webConfig } from "./config.ts";

export interface ApiTokens {
  accessToken: string;
  idToken: string | null;
}

export function apiUrl(path: string): string {
  return `${webConfig().API_INTERNAL_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function authHeaders(tokens: ApiTokens): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    ...(tokens.idToken ? { [ID_TOKEN_HEADER]: tokens.idToken } : {}),
  };
}

export async function apiFetch(
  path: string,
  tokens: ApiTokens | null,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    requestId?: string;
  } = {},
): Promise<Response> {
  return fetch(apiUrl(path), {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(tokens ? authHeaders(tokens) : {}),
      ...(init.requestId ? { "x-request-id": init.requestId } : {}),
      ...init.headers,
    },
    body: init.body ?? null,
    cache: "no-store",
    redirect: "manual",
  });
}
