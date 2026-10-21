// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  devToken,
  type FakeIssuer,
  startFakeIssuer,
  TEST_AUDIENCE,
  TEST_DEV_AUTH_KEY,
} from "../../testing/oidc.ts";
import { isMfa, TokenError, TokenVerifier } from "./token-verifier.ts";

let issuer: FakeIssuer;
let verifier: TokenVerifier;
const PERSON = "01a15c90-0000-7000-8000-000000000001";

beforeAll(async () => {
  issuer = await startFakeIssuer();
  verifier = new TokenVerifier({
    issuer: issuer.issuer,
    audience: TEST_AUDIENCE,
    jwksUrl: issuer.jwksUrl,
  });
});
afterAll(async () => {
  await issuer.close();
});

describe("TokenVerifier", () => {
  it("accepts an access token and takes amr, auth_time, sid and email from the matching ID token", async () => {
    const tokens = await issuer.issue({
      sub: "user-1",
      email: "Anna@Example.test",
      amr: ["pwd", "otp", "mfa"],
      authTime: 1_700_000_000,
      sid: "zitadel-session",
    });
    const verified = await verifier.verify(tokens.accessToken, tokens.idToken);
    expect(verified).toMatchObject({
      subject: "user-1",
      devPersonId: null,
      amr: ["pwd", "otp", "mfa"],
      sessionId: "zitadel-session",
      email: "Anna@Example.test",
      emailVerified: true,
    });
    expect(verified.authTime?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(isMfa(verified.amr)).toBe(true);
  });

  it("works without an ID token, but then knows nothing about the login", async () => {
    const { accessToken } = await issuer.issue({ sub: "user-1" });
    expect(await verifier.verify(accessToken)).toMatchObject({
      amr: [],
      email: null,
      sessionId: null,
    });
  });

  it("refuses an ID token that was not issued with the access token", async () => {
    const a = await issuer.issue({ sub: "user-1", amr: ["pwd"] });
    const b = await issuer.issue({ sub: "user-1", amr: ["pwd", "mfa"] });
    await expect(verifier.verify(a.accessToken, b.idToken)).rejects.toBeInstanceOf(TokenError);
    const other = await issuer.issue({ sub: "user-2" });
    await expect(verifier.verify(a.accessToken, other.idToken)).rejects.toBeInstanceOf(TokenError);
  });

  it("refuses wrong audience, issuer, expiry and garbage, without echoing the token", async () => {
    const wrongAudience = new TokenVerifier({
      issuer: issuer.issuer,
      audience: "other",
      jwksUrl: issuer.jwksUrl,
    });
    const { accessToken } = await issuer.issue({ sub: "user-1" });
    await expect(wrongAudience.verify(accessToken)).rejects.toBeInstanceOf(TokenError);
    const expired = await issuer.issue({ sub: "user-1" }, { expiresIn: "-1m" });
    await expect(verifier.verify(expired.accessToken)).rejects.toBeInstanceOf(TokenError);
    const error = await verifier.verify("not-a-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    const unknownIssuer = new TokenVerifier({
      issuer: "https://elsewhere.test",
      audience: TEST_AUDIENCE,
    });
    const message = await unknownIssuer.verify(accessToken).catch((e: Error) => e.message);
    expect(message).not.toContain(accessToken.split(".")[1]);
  });

  it("refetches the key set on an unknown kid, at most once per cooldown", async () => {
    const own = await startFakeIssuer();
    const v = new TokenVerifier({
      issuer: own.issuer,
      audience: TEST_AUDIENCE,
      jwksUrl: own.jwksUrl,
      jwksCooldownMs: 300,
    });
    await v.verify((await own.issue({ sub: "user-1" })).accessToken);
    expect(own.jwksRequests()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await own.rotate();
    await v.verify((await own.issue({ sub: "user-1" })).accessToken);
    expect(own.jwksRequests()).toBe(2);
    // Unknown kids right after a fetch do not trigger more fetches (cooldown).
    await own.rotate();
    const unknown = (await own.issue({ sub: "user-1" })).accessToken;
    for (let i = 0; i < 5; i++) await expect(v.verify(unknown)).rejects.toBeInstanceOf(TokenError);
    expect(own.jwksRequests()).toBe(2);
    await own.close();
  });

  it("accepts DEV_AUTH tokens only with the development key", async () => {
    const withDev = new TokenVerifier({ devAuthKey: TEST_DEV_AUTH_KEY });
    const token = await devToken(PERSON, { mfa: true });
    expect(await withDev.verify(token)).toMatchObject({
      devPersonId: PERSON,
      subject: `dev:${PERSON}`,
    });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(TokenError);
    await expect(
      withDev.verify(await devToken(PERSON, { key: "x".repeat(40) })),
    ).rejects.toBeInstanceOf(TokenError);
  });

  it("validates in well under a millisecond with a warm key cache (p95)", async () => {
    const tokens = await issuer.issue({ sub: "user-1", email: "a@example.test" });
    await verifier.verify(tokens.accessToken, tokens.idToken);
    const times: number[] = [];
    for (let i = 0; i < 500; i++) {
      const started = performance.now();
      await verifier.verify(tokens.accessToken);
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(1);
  });
});
