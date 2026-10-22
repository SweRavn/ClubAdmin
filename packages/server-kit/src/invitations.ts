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

/**
 * Guardian invitations (P1.3): derived from the ID and the version (the time
 * of the last resend, or 0), so resending gives a new link and the old one
 * stops working.
 */
export const guardianInvitationToken = (
  key: string,
  invitationId: string,
  version: Date | null,
): string =>
  createHmac("sha256", key)
    .update(`guardian-invitation:${invitationId}:${version?.getTime() ?? 0}`, "utf8")
    .digest("base64url");

/** "Give own login" invitations (P1.3, ADR 0020). */
export const accountInvitationToken = (key: string, invitationId: string): string =>
  createHmac("sha256", key)
    .update(`account-invitation:${invitationId}`, "utf8")
    .digest("base64url");

export const guardianInvitationUrl = (webUrl: string, token: string): string =>
  new URL(`/guardian-invitations/${encodeURIComponent(token)}`, webUrl).toString();

/** The own-login page: log in or sign up with the invited address (P0.6 carries ?invitation=). */
export const accountInvitationUrl = (webUrl: string, token: string): string =>
  new URL(`/login?invitation=${encodeURIComponent(token)}`, webUrl).toString();

/** The web page that accepts an invitation link. */
export const invitationUrl = (webUrl: string, token: string): string =>
  new URL(`/join/${encodeURIComponent(token)}`, webUrl).toString();
