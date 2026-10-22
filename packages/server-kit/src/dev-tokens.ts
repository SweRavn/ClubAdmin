// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH tokens (docs/seed-data.md): short-lived HS256 access tokens for a
// chosen person, signed with the shared development key. Minted by the web
// BFF (persona login) and by the API for the mobile app (POST /dev/tokens);
// the API accepts them only when DEV_AUTH is on, which is refused outside
// development.

import { DEV_AUTH_AUDIENCE, DEV_AUTH_ISSUER, DEV_AUTH_SUBJECT_PREFIX } from "@clubadmin/shared";
import { SignJWT } from "jose";

export const DEV_TOKEN_SECONDS = 600;

export interface DevTokenOptions {
  mfa: boolean;
  /** Session ID (`sid`): the BFF session, or a new ID per mobile login. */
  sessionId: string;
  /** Client (`azp`): set for the mobile app, so its sessions are listed like Zitadel ones. */
  clientId?: string;
}

export function mintDevToken(
  key: string,
  personId: string,
  options: DevTokenOptions,
): Promise<string> {
  return new SignJWT({
    amr: options.mfa ? ["pwd", "mfa", "otp"] : ["pwd"],
    auth_time: Math.floor(Date.now() / 1000),
    sid: options.sessionId,
    ...(options.clientId ? { azp: options.clientId } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(DEV_AUTH_ISSUER)
    .setAudience(DEV_AUTH_AUDIENCE)
    .setSubject(`${DEV_AUTH_SUBJECT_PREFIX}${personId}`)
    .setIssuedAt()
    .setExpirationTime(`${DEV_TOKEN_SECONDS}s`)
    .sign(Buffer.from(key, "utf8"));
}
