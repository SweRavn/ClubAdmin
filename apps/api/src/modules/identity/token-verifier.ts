// SPDX-License-Identifier: AGPL-3.0-only
// Access-token validation with jose (ADR 0024). Zitadel's JWT access tokens
// carry only issuer, subject, audience and expiry; how the person logged in
// (amr, auth_time, sid) and their verified email are in the ID token issued
// together with it. Clients therefore send the ID token as well
// (X-Id-Token); it is accepted only if its at_hash matches the access token.
// DEV_AUTH tokens (HS256, iss clubadmin-dev) carry everything themselves.

import { createHash, createSecretKey, timingSafeEqual } from "node:crypto";

import {
  DEV_AUTH_AUDIENCE,
  DEV_AUTH_ISSUER,
  DEV_AUTH_SUBJECT_PREFIX,
  isUuid,
} from "@clubadmin/shared";
import { createRemoteJWKSet, decodeJwt, type JWTPayload, jwtVerify } from "jose";

export interface VerifiedToken {
  subject: string;
  /** DEV_AUTH: the person the token was minted for. */
  devPersonId: string | null;
  /** Authentication methods (amr), from the ID token or the DEV_AUTH token. */
  amr: string[];
  authTime: Date | null;
  /** Identity-provider session (sid). */
  sessionId: string | null;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
  expiresAt: Date;
}

export class TokenError extends Error {
  /** Never contains token contents. */
  constructor(reason: string) {
    super(reason);
    this.name = "TokenError";
  }
}

export interface TokenVerifierOptions {
  issuer?: string | undefined;
  audience?: string | undefined;
  jwksUrl?: string | undefined;
  devAuthKey?: string | undefined;
  /** Seconds of clock skew to accept. */
  clockTolerance?: number;
  /** Minimum time between key-set fetches (unknown kid); 60 s by default. */
  jwksCooldownMs?: number;
}

/** Second factors in Zitadel's amr: one-time codes, security keys, passkeys ("user" + "hwk"/"swk"). */
const MFA_METHODS = new Set(["mfa", "otp", "sms", "email", "hwk", "swk", "u2f"]);

/** MFA from the amr claim: Zitadel adds "mfa" for two factors; we also accept the factor names. */
export function isMfa(amr: readonly string[]): boolean {
  return amr.some((method) => MFA_METHODS.has(method));
}

/** OIDC at_hash: base64url of the left half of the SHA-256 of the access token (RS256/ES256/PS256). */
export function accessTokenHash(accessToken: string): string {
  const digest = createHash("sha256").update(accessToken, "ascii").digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const seconds = (value: unknown): Date | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;

export class TokenVerifier {
  private readonly options: TokenVerifierOptions;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  private readonly devKey: ReturnType<typeof createSecretKey> | undefined;

  constructor(options: TokenVerifierOptions) {
    this.options = options;
    if (options.issuer) {
      const url = options.jwksUrl ?? `${options.issuer.replace(/\/$/, "")}/oauth/v2/keys`;
      // jose caches the key set and refetches on an unknown kid, at most once
      // per cooldown (60 s), so a flood of bad tokens cannot hammer Zitadel.
      this.jwks = createRemoteJWKSet(new URL(url), {
        cooldownDuration: options.jwksCooldownMs ?? 60_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 5_000,
      });
    }
    if (options.devAuthKey) this.devKey = createSecretKey(Buffer.from(options.devAuthKey, "utf8"));
  }

  async verify(accessToken: string, idToken?: string): Promise<VerifiedToken> {
    let issuer: string | null;
    try {
      issuer = str(decodeJwt(accessToken).iss);
    } catch {
      throw new TokenError("malformed token");
    }
    if (issuer === DEV_AUTH_ISSUER && this.devKey) return this.verifyDev(accessToken);
    if (!this.jwks || !this.options.issuer || issuer !== this.options.issuer) {
      throw new TokenError("unknown issuer");
    }
    const access = await this.check(
      accessToken,
      this.jwks,
      this.options.issuer,
      this.options.audience,
    );
    const subject = str(access.sub);
    if (!subject || typeof access.exp !== "number") throw new TokenError("missing claims");

    let id: JWTPayload | undefined;
    if (idToken) {
      id = await this.check(idToken, this.jwks, this.options.issuer, this.options.audience);
      const expected = Buffer.from(accessTokenHash(accessToken));
      const actual = Buffer.from(str(id.at_hash) ?? "");
      if (
        id.sub !== subject ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new TokenError("ID token does not belong to the access token");
      }
    }
    return {
      subject,
      devPersonId: null,
      amr: strings(id?.amr),
      authTime: seconds(id?.auth_time),
      sessionId: str(id?.sid),
      email: str(id?.email),
      emailVerified: id?.email_verified === true,
      givenName: str(id?.given_name),
      familyName: str(id?.family_name),
      expiresAt: new Date(access.exp * 1000),
    };
  }

  private async check(
    token: string,
    key: ReturnType<typeof createRemoteJWKSet>,
    issuer: string,
    audience: string | undefined,
  ): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer,
        ...(audience ? { audience } : {}),
        algorithms: ["RS256", "ES256", "PS256", "EdDSA"],
        clockTolerance: this.options.clockTolerance ?? 5,
      });
      return payload;
    } catch (error) {
      // jose's messages describe the failure (expired, bad signature) without token contents.
      throw new TokenError(error instanceof Error ? error.message : "invalid token");
    }
  }

  private async verifyDev(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.devKey!, {
        issuer: DEV_AUTH_ISSUER,
        audience: DEV_AUTH_AUDIENCE,
        algorithms: ["HS256"],
        clockTolerance: this.options.clockTolerance ?? 5,
      }));
    } catch (error) {
      throw new TokenError(error instanceof Error ? error.message : "invalid token");
    }
    const subject = str(payload.sub);
    const personId = subject?.startsWith(DEV_AUTH_SUBJECT_PREFIX)
      ? subject.slice(DEV_AUTH_SUBJECT_PREFIX.length)
      : null;
    if (!subject || !personId || !isUuid(personId) || typeof payload.exp !== "number") {
      throw new TokenError("missing claims");
    }
    return {
      subject,
      devPersonId: personId,
      amr: strings(payload.amr),
      authTime: seconds(payload.auth_time),
      sessionId: str(payload.sid),
      email: null,
      emailVerified: false,
      givenName: null,
      familyName: null,
      expiresAt: new Date(payload.exp * 1000),
    };
  }
}
