// SPDX-License-Identifier: AGPL-3.0-only
// Browser sessions of the web BFF, stored in Valkey and shared with the API
// (which lists and revokes them). The session record itself holds tokens,
// encrypted by the BFF; the per-person index holds only metadata.

import { z } from "../zod.ts";

/** Encrypted session record (tokens), written and read by the BFF only. */
export const sessionKey = (sessionId: string) => `bff:session:${sessionId}`;
/** Hash handle → StoredSessionMetadata JSON, for listing and revoking a person's sessions. */
export const personSessionsKey = (personId: string) => `bff:person-sessions:${personId}`;

export const SessionMetadataSchema = z
  .object({
    /**
     * Public handle of the session. Never the session ID itself: that is the
     * cookie value, and showing it would let a script take over the session.
     */
    id: z.string(),
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    /** Coarse device description from the User-Agent, e.g. "Firefox on Linux". */
    device: z.string().max(100),
    /** Zitadel session ID (`sid`), ended when the session is revoked. */
    idpSessionId: z.string().nullable(),
    devAuth: z.boolean(),
  })
  .openapi("Session");
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

/** What the index stores: the metadata plus the (secret) session ID, for revoking. */
export const StoredSessionMetadataSchema = SessionMetadataSchema.extend({ storageId: z.string() });
export type StoredSessionMetadata = z.infer<typeof StoredSessionMetadataSchema>;

/** Sessions live as long as the identity provider's refresh tokens may be idle. */
export const SESSION_TTL_SECONDS = 30 * 86_400;
