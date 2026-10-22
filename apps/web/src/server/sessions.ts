// SPDX-License-Identifier: AGPL-3.0-only
// Session lifecycle in the BFF: create after login (always a new session ID,
// so a fixated ID is useless), load from the cookie, refresh tokens with
// rotation, and destroy on logout or when a refresh token is rejected (it may
// have been stolen and used: refresh-token reuse).

import { DEV_TOKEN_SECONDS, mintDevToken } from "@clubadmin/server-kit/dev-tokens";

import { webConfig } from "./config.ts";
import { client, oidcClient } from "./oidc.ts";
import {
  newCsrfToken,
  newSessionHandle,
  type SessionRecord,
  SessionStore,
} from "./session-store.ts";
import { valkey } from "./valkey.ts";

/** Refresh when the access token has less than this left (ms). */
const REFRESH_MARGIN_MS = 30_000;

let store: SessionStore | undefined;

function encryptionKey(): Buffer {
  const configured = webConfig().SESSION_ENCRYPTION_KEY;
  if (configured) return Buffer.from(configured, "base64");
  // Development without a configured key: a per-process key (sessions end on restart).
  const holder = globalThis as { __clubadminSessionKey?: Buffer };
  holder.__clubadminSessionKey ??= Buffer.from(newCsrfToken(), "base64url").subarray(0, 32);
  return holder.__clubadminSessionKey;
}

export function sessionStore(): SessionStore {
  store ??= new SessionStore(valkey(), encryptionKey());
  return store;
}

export interface Session {
  id: string;
  record: SessionRecord;
}

export async function loadSession(id: string | undefined): Promise<Session | null> {
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const record = await sessionStore().get(id);
  return record ? { id, record } : null;
}

export async function createSession(
  record: Omit<SessionRecord, "csrf" | "createdAt" | "handle">,
  options: { handle?: string } = {},
): Promise<{ id: string; csrf: string; handle: string }> {
  const csrf = newCsrfToken();
  const handle = options.handle ?? newSessionHandle();
  const id = await sessionStore().create({
    ...record,
    handle,
    csrf,
    createdAt: new Date().toISOString(),
  });
  return { id, csrf, handle };
}

/**
 * The session with an access token valid for at least 30 s, refreshing it if
 * needed. Returns null (and removes the session) if it can no longer be used.
 */
export async function freshSession(session: Session): Promise<Session | null> {
  if (session.record.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    void sessionStore().touch(session.record);
    return session;
  }
  const unlock = await sessionStore().lock(session.id);
  try {
    // Another request may have refreshed it while we waited for the lock.
    const current = await sessionStore().get(session.id);
    if (!current) return null;
    if (current.expiresAt - Date.now() > REFRESH_MARGIN_MS)
      return { id: session.id, record: current };
    const refreshed = await refresh(current);
    if (!refreshed) {
      await endSession({ id: session.id, record: current });
      return null;
    }
    await sessionStore().update(session.id, refreshed);
    return { id: session.id, record: refreshed };
  } finally {
    await unlock();
  }
}

async function refresh(record: SessionRecord): Promise<SessionRecord | null> {
  const config = webConfig();
  if (record.devAuth) {
    if (!config.DEV_AUTH || !config.DEV_AUTH_KEY) return null;
    return {
      ...record,
      accessToken: await mintDevToken(config.DEV_AUTH_KEY, record.personId, {
        mfa: record.devMfa ?? false,
        sessionId: record.handle,
      }),
      expiresAt: Date.now() + DEV_TOKEN_SECONDS * 1000,
    };
  }
  if (!record.refreshToken) return null;
  try {
    const tokens = await client.refreshTokenGrant(await oidcClient(), record.refreshToken);
    return {
      ...record,
      accessToken: tokens.access_token,
      idToken: tokens.id_token ?? record.idToken,
      // Zitadel rotates refresh tokens; the old one is now invalid.
      refreshToken: tokens.refresh_token ?? record.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn() ?? 60) * 1000,
    };
  } catch (error) {
    // invalid_grant: the refresh token was used or revoked elsewhere. Treat as
    // possible theft: the session ends (and the remaining tokens are revoked).
    if (error instanceof client.ResponseBodyError && error.error === "invalid_grant") return null;
    throw error;
  }
}

/** Logout: removes the session and revokes its refresh token at the identity provider. */
export async function endSession(session: Session): Promise<void> {
  await sessionStore().destroy(session.id, session.record);
  if (session.record.devAuth || !session.record.refreshToken) return;
  try {
    await client.tokenRevocation(await oidcClient(), session.record.refreshToken);
  } catch {
    // Already invalid; nothing else to do.
  }
}
