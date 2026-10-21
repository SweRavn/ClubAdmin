// SPDX-License-Identifier: AGPL-3.0-only
// A signed-in session for checks against the production build, which has no
// DEV_AUTH picker: writes a session for a person straight into Valkey with a
// development token the API accepts (the API runs with DEV_AUTH in CI). The
// production server must use the same SESSION_ENCRYPTION_KEY. Lives 10
// minutes (the token cannot be refreshed without DEV_AUTH). Test tooling
// only; never part of the app.
//
//   node apps/web/scripts/test-session.ts <personId>   → prints the cookie header

import { Redis } from "ioredis";

import { DEV_TOKEN_SECONDS, mintDevToken } from "../src/server/dev-tokens.ts";
import { newCsrfToken, newSessionHandle, SessionStore } from "../src/server/session-store.ts";

export async function createTestSession(personId: string): Promise<{ id: string; csrf: string }> {
  const { DEV_AUTH_KEY, SESSION_ENCRYPTION_KEY, VALKEY_URL } = process.env;
  if (!DEV_AUTH_KEY || !SESSION_ENCRYPTION_KEY) {
    throw new Error("DEV_AUTH_KEY and SESSION_ENCRYPTION_KEY are needed (from .env.local)");
  }
  const valkey = new Redis(VALKEY_URL ?? "redis://127.0.0.1:6379");
  try {
    const handle = newSessionHandle();
    const csrf = newCsrfToken();
    const id = await new SessionStore(valkey, Buffer.from(SESSION_ENCRYPTION_KEY, "base64")).create(
      {
        personId,
        handle,
        accessToken: await mintDevToken(DEV_AUTH_KEY, personId, { mfa: false, sessionId: handle }),
        idToken: null,
        refreshToken: null,
        expiresAt: Date.now() + DEV_TOKEN_SECONDS * 1000,
        idpSessionId: null,
        csrf,
        devAuth: true,
        createdAt: new Date().toISOString(),
        device: "test session",
      },
    );
    return { id, csrf };
  } finally {
    valkey.disconnect();
  }
}

if (import.meta.main) {
  const personId = process.argv[2];
  if (!personId) throw new Error("usage: test-session.ts <personId>");
  const { id, csrf } = await createTestSession(personId);
  console.log(`__Host-session=${id}; __Host-csrf=${csrf}`);
}
