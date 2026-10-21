// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH: the BFF signs short-lived tokens for a chosen person with the
// shared development key; the API accepts them only when DEV_AUTH is on.

import { DEV_AUTH_AUDIENCE, DEV_AUTH_ISSUER, DEV_AUTH_SUBJECT_PREFIX } from "@clubadmin/shared";
import { SignJWT } from "jose";

export const DEV_TOKEN_SECONDS = 600;

export function mintDevToken(
  key: string,
  personId: string,
  options: { mfa: boolean; sessionId: string },
): Promise<string> {
  return new SignJWT({
    amr: options.mfa ? ["pwd", "mfa", "otp"] : ["pwd"],
    auth_time: Math.floor(Date.now() / 1000),
    sid: options.sessionId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(DEV_AUTH_ISSUER)
    .setAudience(DEV_AUTH_AUDIENCE)
    .setSubject(`${DEV_AUTH_SUBJECT_PREFIX}${personId}`)
    .setIssuedAt()
    .setExpirationTime(`${DEV_TOKEN_SECONDS}s`)
    .sign(Buffer.from(key, "utf8"));
}
