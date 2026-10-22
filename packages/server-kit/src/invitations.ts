// SPDX-License-Identifier: AGPL-3.0-only
// Club invitation secrets (P1.1, ADR 0032). The database stores only a hash.
// Links and codes are random and shown once to their creator; the token of an
// email invitation is derived from its ID with INVITATION_TOKEN_KEY, so the
// worker can put it in the email without the token being stored anywhere.

import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

/** The alphabet of invitation codes (no look-alikes); same as INVITATION_CODE_ALPHABET in @clubadmin/shared. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** SHA-256 of a token or a normalised code, as stored in invitations.token_hash. */
export const hashInvitationSecret = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("base64url");

export const randomInvitationToken = (): string => randomBytes(32).toString("base64url");

export const randomInvitationCode = (): string =>
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

/** The token of an email invitation: HMAC-SHA256 of its ID (rotating the key invalidates open ones). */
export const emailInvitationToken = (key: string, invitationId: string): string =>
  createHmac("sha256", key).update(`club-invitation:${invitationId}`, "utf8").digest("base64url");

/** The web page that accepts an invitation link. */
export const invitationUrl = (webUrl: string, token: string): string =>
  new URL(`/join/${encodeURIComponent(token)}`, webUrl).toString();
