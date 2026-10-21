// SPDX-License-Identifier: AGPL-3.0-only
// Server-side sessions in Valkey (ADR 0005, BFF): the browser holds only a
// random session ID in an HttpOnly cookie. The record with the tokens is
// encrypted with SESSION_ENCRYPTION_KEY (AES-256-GCM, bound to the session
// ID); the per-person index (metadata only) lets the API list and revoke
// sessions (packages/shared/src/auth/sessions.ts).

import { randomBytes } from "node:crypto";

import { decryptField, encryptField } from "@clubadmin/server-kit/crypto";
import {
  personSessionsKey,
  SESSION_TTL_SECONDS,
  sessionKey,
  type StoredSessionMetadata,
} from "@clubadmin/shared";
import type { Redis } from "ioredis";

export interface SessionRecord {
  personId: string;
  /** Public handle in the session list (the session ID itself stays secret). */
  handle: string;
  accessToken: string;
  /** Sent to the API with the access token (ADR 0024). */
  idToken: string | null;
  refreshToken: string | null;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  idpSessionId: string | null;
  /** Double-submit CSRF token (also in the __Host-csrf cookie). */
  csrf: string;
  devAuth: boolean;
  /** DEV_AUTH: second factor toggled in the picker. */
  devMfa?: boolean;
  createdAt: string;
  device: string;
}

/** Session IDs: 256 random bits, base64url. */
export const newSessionId = (): string => randomBytes(32).toString("base64url");
export const newCsrfToken = (): string => randomBytes(32).toString("base64url");
/** Public session handle (shown in the session list): random, unrelated to the session ID. */
export const newSessionHandle = (): string => randomBytes(12).toString("base64url");

const KEY_ID = "session";
/** Last-seen is written at most this often (ms), not on every request. */
const TOUCH_INTERVAL_MS = 60_000;

export class SessionStore {
  private readonly valkey: Redis;
  private readonly key: Buffer;

  constructor(valkey: Redis, encryptionKey: Buffer) {
    if (encryptionKey.length !== 32)
      throw new Error("SESSION_ENCRYPTION_KEY must be 32 bytes (base64)");
    this.valkey = valkey;
    this.key = encryptionKey;
  }

  /** Stores a new session; `id` is generated unless the caller made one (DEV_AUTH tokens name it). */
  async create(record: SessionRecord, id: string = newSessionId()): Promise<string> {
    const now = new Date().toISOString();
    const metadata: StoredSessionMetadata = {
      id: record.handle,
      storageId: id,
      createdAt: record.createdAt,
      lastSeenAt: now,
      device: record.device,
      idpSessionId: record.idpSessionId,
      devAuth: record.devAuth,
    };
    await this.valkey
      .multi()
      .set(sessionKey(id), this.seal(id, record), "EX", SESSION_TTL_SECONDS)
      .hset(personSessionsKey(record.personId), record.handle, JSON.stringify(metadata))
      .expire(personSessionsKey(record.personId), SESSION_TTL_SECONDS)
      .exec();
    return id;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const sealed = await this.valkey.get(sessionKey(id));
    if (!sealed) return null;
    try {
      return JSON.parse(decryptField(this.key, sealed, `session:${id}`)) as SessionRecord;
    } catch {
      // Wrong key (rotated) or tampered: treat as logged out.
      return null;
    }
  }

  /** Replaces the record (refreshed tokens), keeping its expiry window. */
  async update(id: string, record: SessionRecord): Promise<void> {
    await this.valkey.set(sessionKey(id), this.seal(id, record), "EX", SESSION_TTL_SECONDS, "XX");
  }

  /** Updates last-seen in the index, at most once per minute per session. */
  async touch(record: SessionRecord): Promise<void> {
    const throttle = await this.valkey.set(
      `bff:session-touch:${record.handle}`,
      "1",
      "PX",
      TOUCH_INTERVAL_MS,
      "NX",
    );
    if (throttle !== "OK") return;
    const raw = await this.valkey.hget(personSessionsKey(record.personId), record.handle);
    if (!raw) return;
    const metadata = {
      ...(JSON.parse(raw) as StoredSessionMetadata),
      lastSeenAt: new Date().toISOString(),
    };
    await this.valkey.hset(
      personSessionsKey(record.personId),
      record.handle,
      JSON.stringify(metadata),
    );
  }

  async destroy(
    id: string,
    record: Pick<SessionRecord, "personId" | "handle"> | null,
  ): Promise<void> {
    const tx = this.valkey.multi().del(sessionKey(id));
    if (record) tx.hdel(personSessionsKey(record.personId), record.handle);
    await tx.exec();
  }

  /** Serialises token refreshes of one session (returns false if another request holds the lock). */
  async lock(id: string): Promise<() => Promise<void>> {
    const key = `bff:session-lock:${id}`;
    const token = newCsrfToken();
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await this.valkey.set(key, token, "PX", 10_000, "NX")) === "OK") {
        return async () => {
          if ((await this.valkey.get(key)) === token) await this.valkey.del(key);
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("session lock timeout");
  }

  private seal(id: string, record: SessionRecord): string {
    return encryptField(this.key, KEY_ID, JSON.stringify(record), `session:${id}`);
  }
}
