// SPDX-License-Identifier: AGPL-3.0-only
// A fake OIDC issuer for tests: serves a JWKS over HTTP and signs access and
// ID tokens shaped like Zitadel's (ADR 0024).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DEV_AUTH_AUDIENCE, DEV_AUTH_ISSUER, uuidv7 } from "@clubadmin/shared";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import { accessTokenHash } from "../modules/identity/index.ts";

export const TEST_AUDIENCE = "test-project";
export const TEST_CLIENT = "test-web-client";
export const TEST_MOBILE_CLIENT = "test-mobile-client";

export interface IssuedTokens {
  accessToken: string;
  idToken: string;
}

export interface UserClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  givenName?: string;
  familyName?: string;
  amr?: string[];
  authTime?: number;
  sid?: string;
  /** OIDC client (azp, client_id); defaults to the web client. */
  clientId?: string;
}

export interface FakeIssuer {
  issuer: string;
  jwksUrl: string;
  /** How often the JWKS was fetched. */
  jwksRequests(): number;
  issue(claims: UserClaims, options?: { expiresIn?: string; kid?: string }): Promise<IssuedTokens>;
  /** Zitadel session IDs deleted through DELETE /v2/sessions/:id. */
  deletedSessions: string[];
  /** Adds a new signing key (kid) and uses it from now on. */
  rotate(): Promise<string>;
  close(): Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const keys: {
    kid: string;
    privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    jwk: JWK;
  }[] = [];
  const addKey = async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = uuidv7();
    keys.push({
      kid,
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
    });
    return kid;
  };
  await addKey();
  let requests = 0;
  const deletedSessions: string[] = [];
  const server: Server = createServer((req, res) => {
    const session =
      req.method === "DELETE" ? /^\/v2\/sessions\/([^/]+)$/.exec(req.url ?? "") : null;
    if (session) {
      deletedSessions.push(decodeURIComponent(session[1]!));
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    if (req.url === "/oauth/v2/keys") {
      requests += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: keys.map((k) => k.jwk) }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    jwksUrl: `${issuer}/oauth/v2/keys`,
    jwksRequests: () => requests,
    deletedSessions,
    async issue(claims, options = {}) {
      const key = keys.find((k) => k.kid === options.kid) ?? keys.at(-1)!;
      const expiresIn = options.expiresIn ?? "10m";
      const accessToken = await new SignJWT({ client_id: claims.clientId ?? TEST_CLIENT })
        .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
        .setIssuer(issuer)
        .setSubject(claims.sub)
        .setAudience([TEST_CLIENT, TEST_AUDIENCE])
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .setJti(uuidv7())
        .sign(key.privateKey);
      const idToken = await new SignJWT({
        at_hash: accessTokenHash(accessToken),
        amr: claims.amr ?? ["pwd"],
        auth_time: claims.authTime ?? Math.floor(Date.now() / 1000),
        sid: claims.sid ?? uuidv7(),
        azp: claims.clientId ?? TEST_CLIENT,
        ...(claims.email !== undefined
          ? { email: claims.email, email_verified: claims.emailVerified ?? true }
          : {}),
        ...(claims.givenName ? { given_name: claims.givenName } : {}),
        ...(claims.familyName ? { family_name: claims.familyName } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
        .setIssuer(issuer)
        .setSubject(claims.sub)
        .setAudience([TEST_CLIENT, TEST_AUDIENCE])
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(key.privateKey);
      return { accessToken, idToken };
    },
    rotate: addKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const TEST_DEV_AUTH_KEY = "test-dev-auth-key-0123456789abcdef";

/** A DEV_AUTH token as the web app mints it. */
export function devToken(
  personId: string,
  options: { mfa?: boolean; key?: string; sid?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({
    amr: options.mfa ? ["pwd", "mfa", "otp"] : ["pwd"],
    auth_time: Math.floor(Date.now() / 1000),
    sid: options.sid ?? uuidv7(),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(DEV_AUTH_ISSUER)
    .setAudience(DEV_AUTH_AUDIENCE)
    .setSubject(`dev:${personId}`)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "10m")
    .sign(Buffer.from(options.key ?? TEST_DEV_AUTH_KEY, "utf8"));
}
