// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH for development builds: the persona list and development tokens
// come from the API (POST /api/v1/dev/tokens), which exists only when the
// server runs with DEV_AUTH; the app never holds the signing key.

import { DevTokenResponseSchema, type PersonaList, PersonaListSchema } from "@clubadmin/shared";

import { appConfig } from "../config.ts";
import type { TokenSet } from "./tokens.ts";

export async function fetchPersonas(): Promise<PersonaList> {
  const res = await fetch(`${appConfig.apiUrl}/api/v1/dev/personas`);
  if (!res.ok) throw new Error(`personas: HTTP ${res.status}`);
  return PersonaListSchema.parse(await res.json());
}

export async function fetchDevTokens(personId: string, mfa: boolean): Promise<TokenSet> {
  const res = await fetch(`${appConfig.apiUrl}/api/v1/dev/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personId, mfa }),
  });
  if (!res.ok) throw new Error(`dev tokens: HTTP ${res.status}`);
  const body = DevTokenResponseSchema.parse(await res.json());
  return { accessToken: body.accessToken, idToken: null, expiresAt: Date.parse(body.expiresAt) };
}
