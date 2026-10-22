// SPDX-License-Identifier: AGPL-3.0-only
// The mobile app's login against the real Zitadel, done the way the app does
// it (P0.10, ADR 0028): authorization code + PKCE for the native `mobile`
// client with its custom-scheme redirect, refresh with rotation, and the API
// listing the app's session in /me/sessions. Revoking that session ends the
// Zitadel session; Zitadel still honours the app's refresh token afterwards,
// so the API refuses every token of the revoked session (ADR 0028).

import { createHash, randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { AUTH_URL, createUser, uniqueEmail } from "./helpers.ts";

const PASSWORD = "Testlosen123";
const API_URL = process.env.MOBILE_API_URL ?? "https://api.clubadmin.localhost";
const CLIENT_ID = process.env.AUTH_MOBILE_CLIENT_ID ?? "";
const PROJECT_ID = process.env.AUTH_PROJECT_ID ?? "";
const REDIRECT = "clubadmin-dev://auth/callback";

const base64url = (buffer: Buffer) => buffer.toString("base64url");

interface Tokens {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  error?: string;
}

async function token(body: Record<string, string>): Promise<{ status: number; json: Tokens }> {
  const res = await fetch(`${AUTH_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }).toString(),
  });
  return { status: res.status, json: (await res.json()) as Tokens };
}

const appHeaders = (tokens: Tokens) => ({
  authorization: `Bearer ${tokens.access_token}`,
  ...(tokens.id_token ? { "x-id-token": tokens.id_token } : {}),
  "x-client-platform": "android",
  "x-client-version": "0.1.0",
  "x-client-device": "Playwright (Android 16)",
});

test("mobile PKCE login, rotation, and a revoked app session cannot refresh", async ({ page }) => {
  test.skip(!CLIENT_ID, "AUTH_MOBILE_CLIENT_ID is not set (pnpm auth:configure)");
  const email = uniqueEmail("mia");
  await createUser(email, PASSWORD);

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const authorize = new URL(`${AUTH_URL}/oauth/v2/authorize`);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: `openid profile email offline_access${PROJECT_ID ? ` urn:zitadel:iam:org:project:id:${PROJECT_ID}:aud` : ""}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: base64url(randomBytes(8)),
    prompt: "login",
  }).toString();

  // The browser cannot open the app's scheme; catch Zitadel's redirect to it.
  const redirected = page.waitForResponse((res) =>
    (res.headers().location ?? "").startsWith(REDIRECT),
  );
  await page.goto(authorize.toString());
  await page.getByLabel("E-postadress").fill(email);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  const skip = page.getByRole("button", { name: /Använd inte 2-faktor|Hoppa över|Skip/ });
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  const location = new URL((await redirected).headers().location!);
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();

  // A wrong verifier is refused (PKCE), the right one gives tokens with a refresh token.
  expect(
    (
      await token({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        code_verifier: "x".repeat(43),
      })
    ).status,
  ).toBe(400);
  const first = await token({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  // The code was used up by the failed attempt in some providers; Zitadel keeps it for the verifier check.
  expect(first.status).toBe(200);
  expect(first.json.refresh_token).toBeTruthy();

  // The API knows the person and lists the app's session.
  const me = await fetch(`${API_URL}/api/v1/me`, { headers: appHeaders(first.json) });
  expect(me.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const list = (await (
    await fetch(`${API_URL}/api/v1/me/sessions`, { headers: appHeaders(first.json) })
  ).json()) as { sessions: { id: string; client: string; current: boolean; device: string }[] };
  const session = list.sessions.find((s) => s.client === "mobile");
  expect(session).toMatchObject({ current: true, device: "Playwright (Android 16), app 0.1.0" });

  // Refresh with rotation: the new refresh token works, the old one is spent.
  const second = await token({
    grant_type: "refresh_token",
    refresh_token: first.json.refresh_token!,
  });
  expect(second.status).toBe(200);
  expect(second.json.refresh_token).toBeTruthy();
  expect(second.json.refresh_token).not.toBe(first.json.refresh_token);

  // Revoking the app's session (e.g. from the web app) ends its Zitadel session…
  const revoke = await fetch(`${API_URL}/api/v1/me/sessions/${session!.id}`, {
    method: "DELETE",
    headers: appHeaders(second.json),
  });
  expect(revoke.status).toBe(204);
  // …and the API refuses the session's tokens from then on, also freshly refreshed ones.
  const stale = await fetch(`${API_URL}/api/v1/me`, { headers: appHeaders(second.json) });
  expect(stale.status).toBe(401);
  expect(((await stale.json()) as { detail?: string }).detail).toBe("session_revoked");
  const after = await token({
    grant_type: "refresh_token",
    refresh_token: second.json.refresh_token!,
  });
  if (after.status === 200) {
    const refreshed = await fetch(`${API_URL}/api/v1/me`, { headers: appHeaders(after.json) });
    expect(refreshed.status).toBe(401);
  } else {
    expect(after.json.error).toBe("invalid_grant");
  }
  // Public endpoints treat the revoked tokens as anonymous.
  const meta = await fetch(`${API_URL}/api/v1/meta/client`, { headers: appHeaders(second.json) });
  expect(meta.status).toBe(200);
});
