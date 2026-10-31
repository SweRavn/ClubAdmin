// SPDX-License-Identifier: AGPL-3.0-only
// Lists and revokes a person's sessions. The web BFF keeps browser sessions
// in Valkey (packages/shared/src/auth/sessions.ts); revoking deletes the BFF
// session (the browser is logged out on its next request) and ends the
// Zitadel session, so the person must log in again there too. Mobile app
// sessions are registered here on their first request (touchMobile). The app
// holds its own tokens, and ending the Zitadel session does not invalidate
// its refresh token (checked against Zitadel in apps/web/e2e), so revoking
// also puts the session on a deny list: the AuthGuard refuses every token of
// that Zitadel session from then on, refreshed or not (ADR 0028).

import { type ActorContext, audit, type Database } from "@clubadmin/db";
import {
  CLIENT_DEVICE_HEADER,
  CLIENT_PLATFORM_HEADER,
  CLIENT_VERSION_HEADER,
  personSessionsKey,
  SESSION_TTL_SECONDS,
  sessionKey,
  type SessionMetadata,
  type StoredSessionMetadata,
  StoredSessionMetadataSchema,
} from "@clubadmin/shared";
import type { FastifyRequest } from "fastify";

import { mobileSessionHandle } from "../../platform/http/session-handle.ts";
import type { ValkeyClient } from "../../platform/infra/valkey.ts";

export interface ZitadelSessions {
  /** Ends a Zitadel session; ignores sessions that are already gone. */
  end(sessionId: string): Promise<void>;
}

/** Zitadel session API v2 with the clubadmin-api machine user (IAM_LOGIN_CLIENT). */
export function zitadelSessions(baseUrl: string, token: string): ZitadelSessions {
  return {
    async end(sessionId) {
      const res = await fetch(
        `${baseUrl.replace(/\/$/, "")}/v2/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!res.ok && res.status !== 404)
        throw new Error(`Zitadel session delete failed: HTTP ${res.status}`);
    },
  };
}

/** How often a mobile session's lastSeenAt is written (per API instance and session). */
const TOUCH_INTERVAL_MS = 5 * 60_000;
const TOUCHED_MAX = 50_000;
/** Revoked mobile sessions, by handle: their tokens are refused (deny list). */
const revokedKey = (handle: string) => `api:revoked-session:${handle}`;
/** As long as the session's refresh tokens can live (Zitadel: 90 days at most). */
const REVOKED_TTL_SECONDS = 90 * 86_400;
/** How long one API instance trusts a "not revoked" answer (revocation reaches other instances within this). */
const NOT_REVOKED_CACHE_MS = 10_000;

export { mobileSessionHandle };

/** What ending an app session also ends: its phone's push notifications (P1.7). */
export interface SessionDevices {
  removeForSession(context: ActorContext, handle: string): Promise<number>;
}

const headerText = (request: FastifyRequest, name: string, max: number) => {
  const value = request.headers[name];
  const text = (Array.isArray(value) ? value[0] : value) ?? "";
  // Printable text only; this is shown back to the person in the session list.
  return text
    .replace(/[^\p{L}\p{N} ._()/,+-]/gu, "")
    .trim()
    .slice(0, max);
};

/** "Pixel 8 (Android 16), app 1.0.0" from the app's headers; never a device identifier. */
export function mobileDevice(request: FastifyRequest): string {
  const device = headerText(request, CLIENT_DEVICE_HEADER, 60);
  const platform = headerText(request, CLIENT_PLATFORM_HEADER, 10);
  const version = headerText(request, CLIENT_VERSION_HEADER, 20);
  const name = device || (platform === "ios" ? "iOS" : platform === "android" ? "Android" : "");
  return [name || "ClubAdmin app", version ? `app ${version}` : ""].filter(Boolean).join(", ");
}

export class SessionsService {
  private readonly db: Database;
  private readonly valkey: ValkeyClient;
  private readonly zitadel: ZitadelSessions | undefined;
  /** Mobile session handle → when it may be written again. */
  private readonly touched = new Map<string, number>();
  /** Mobile session handle → until when it is known not to be revoked. */
  private readonly notRevoked = new Map<string, number>();

  private readonly devices: SessionDevices | undefined;

  constructor(
    db: Database,
    valkey: ValkeyClient,
    zitadel: ZitadelSessions | undefined,
    devices?: SessionDevices,
  ) {
    this.db = db;
    this.valkey = valkey;
    this.zitadel = zitadel;
    this.devices = devices;
  }

  async list(personId: string): Promise<SessionMetadata[]> {
    if (!this.valkey) return [];
    const entries = await this.valkey.hgetall(personSessionsKey(personId));
    const sessions: SessionMetadata[] = [];
    for (const value of Object.values(entries)) {
      const parsed = StoredSessionMetadataSchema.safeParse(JSON.parse(value));
      if (parsed.success) {
        const { storageId: _secret, ...metadata } = parsed.data;
        sessions.push(metadata);
      }
    }
    return sessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /** Revokes one of the acting person's sessions by its handle (audited). Returns false if there is no such session. */
  async revoke(context: ActorContext & { personId: string }, handle: string): Promise<boolean> {
    const personId = context.personId;
    if (!this.valkey) return false;
    const raw = await this.valkey.hget(personSessionsKey(personId), handle);
    if (!raw) return false;
    const metadata = StoredSessionMetadataSchema.safeParse(JSON.parse(raw));
    const tx = this.valkey.multi().hdel(personSessionsKey(personId), handle);
    if (metadata.success && metadata.data.storageId) tx.del(sessionKey(metadata.data.storageId));
    if (metadata.success && metadata.data.client === "mobile") {
      tx.set(revokedKey(handle), "1", "EX", REVOKED_TTL_SECONDS);
    }
    await tx.exec();
    this.touched.delete(handle);
    this.notRevoked.delete(handle);
    if (metadata.success && metadata.data.idpSessionId && !metadata.data.devAuth && this.zitadel) {
      await this.zitadel.end(metadata.data.idpSessionId);
    }
    // The phone of an ended app session gets no more push notifications.
    if (metadata.success && metadata.data.client === "mobile" && this.devices) {
      await this.devices.removeForSession(context, handle);
    }
    await this.db.withActor(context, (tx) =>
      audit.record(tx, { action: "session.revoked", resourceType: "session" }),
    );
    return true;
  }

  /**
   * Whether a mobile app session was revoked (its tokens must be refused).
   * Fails open when Valkey is unreachable, like the rate limits.
   */
  async isRevoked(idpSessionId: string): Promise<boolean> {
    if (!this.valkey) return false;
    const handle = mobileSessionHandle(idpSessionId);
    const now = Date.now();
    if ((this.notRevoked.get(handle) ?? 0) > now) return false;
    try {
      if ((await this.valkey.exists(revokedKey(handle))) === 1) return true;
    } catch {
      return false;
    }
    if (this.notRevoked.size >= TOUCHED_MAX) this.notRevoked.clear();
    this.notRevoked.set(handle, now + NOT_REVOKED_CACHE_MS);
    return false;
  }

  /**
   * Registers or refreshes a mobile app session in the person's session list.
   * Written at most every few minutes per session; never delays the request
   * (errors are ignored: the list is informational).
   */
  touchMobile(
    personId: string,
    idpSessionId: string,
    request: FastifyRequest,
    devAuth: boolean,
  ): void {
    const valkey = this.valkey;
    if (!valkey) return;
    const handle = mobileSessionHandle(idpSessionId);
    const now = Date.now();
    if ((this.touched.get(handle) ?? 0) > now) return;
    if (this.touched.size >= TOUCHED_MAX) this.touched.clear();
    this.touched.set(handle, now + TOUCH_INTERVAL_MS);
    const key = personSessionsKey(personId);
    void (async () => {
      const [revoked, raw] = await Promise.all([
        valkey.exists(revokedKey(handle)),
        valkey.hget(key, handle),
      ]);
      if (revoked) return;
      const existing = raw ? StoredSessionMetadataSchema.safeParse(JSON.parse(raw)) : null;
      const at = new Date(now).toISOString();
      const metadata: StoredSessionMetadata = {
        id: handle,
        storageId: null,
        createdAt: existing?.success ? existing.data.createdAt : at,
        lastSeenAt: at,
        device: mobileDevice(request),
        idpSessionId,
        devAuth,
        client: "mobile",
      };
      await valkey
        .multi()
        .hset(key, handle, JSON.stringify(metadata))
        .expire(key, SESSION_TTL_SECONDS)
        .exec();
    })().catch(() => {
      this.touched.delete(handle);
    });
  }
}
