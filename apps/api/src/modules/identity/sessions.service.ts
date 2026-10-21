// SPDX-License-Identifier: AGPL-3.0-only
// Lists and revokes a person's browser sessions. The web BFF keeps them in
// Valkey (packages/shared/src/auth/sessions.ts); revoking deletes the BFF
// session (the browser is logged out on its next request) and ends the
// Zitadel session, so the person must log in again there too.

import { type ActorContext, audit, type Database } from "@clubadmin/db";
import {
  personSessionsKey,
  sessionKey,
  type SessionMetadata,
  StoredSessionMetadataSchema,
} from "@clubadmin/shared";

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

export class SessionsService {
  private readonly db: Database;
  private readonly valkey: ValkeyClient;
  private readonly zitadel: ZitadelSessions | undefined;

  constructor(db: Database, valkey: ValkeyClient, zitadel: ZitadelSessions | undefined) {
    this.db = db;
    this.valkey = valkey;
    this.zitadel = zitadel;
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
    if (metadata.success) tx.del(sessionKey(metadata.data.storageId));
    await tx.exec();
    if (metadata.success && metadata.data.idpSessionId && this.zitadel) {
      await this.zitadel.end(metadata.data.idpSessionId);
    }
    await this.db.withActor(context, (tx) =>
      audit.record(tx, { action: "session.revoked", resourceType: "session" }),
    );
    return true;
  }
}
