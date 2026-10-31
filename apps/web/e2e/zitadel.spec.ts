// SPDX-License-Identifier: AGPL-3.0-only
// Real login through Zitadel's login pages: sign up, verify the email from
// Mailpit, land on the home page; duplicate email; MFA step-up with TOTP;
// logout; a demo persona with email and password (`pnpm dev:idp-sync`, P1.6b).

import { expect, type Page, test } from "@playwright/test";

import { enrolTotp, totp, uniqueEmail, verificationCode, waitForMail } from "./helpers.ts";

const PASSWORD = "Testlosen123";
const email = uniqueEmail("emma");

test.describe.configure({ mode: "serial" });

async function signUp(page: Page, address: string): Promise<void> {
  await page.goto("/auth/login");
  await page.getByText("Skapa konto").click();
  await page.getByLabel("Förnamn").fill("Emma");
  await page.getByLabel("Efternamn").fill("Svensson");
  await page.getByLabel("E-postadress").fill(address);
  await page.getByLabel("Lösenord", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Lösenord igen").fill(PASSWORD);
  await page.getByRole("button", { name: "Fortsätt" }).click();
}

/** Zitadel may offer to set up a second factor after login; skip it. */
async function skipMfaPrompt(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: /Använd inte 2-faktor|Hoppa över|Skip/ });
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
}

async function logIn(
  page: Page,
  address: string,
  otpSecret?: string,
  password = PASSWORD,
): Promise<void> {
  await page.goto("/auth/login?returnTo=%2Fme");
  await page.getByTestId("real-login").click();
  // Zitadel remembers accounts used in this browser and may offer them first.
  const other = page.getByRole("button", { name: /Välj ett annat konto|Other account/ });
  const emailField = page.getByLabel("E-postadress");
  await expect(other.or(emailField)).toBeVisible();
  if (await other.isVisible()) await other.click();
  await emailField.fill(address);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  await page.getByLabel("Lösenord").fill(password);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  if (otpSecret) {
    await page.getByLabel("Kod").fill(totp(otpSecret));
    await page.getByRole("button", { name: /Kontrollera|Fortsätt|Verifiera/ }).click();
  } else {
    await skipMfaPrompt(page);
  }
  await page.waitForURL("**/me");
}

test("sign up, verify the email in Mailpit, log in: the app knows the new person", async ({
  page,
  context,
}) => {
  const before = (await context.cookies()).find((c) => c.name === "__Host-session")?.value;
  await signUp(page, email);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Aktivera|Verifiera/);
  await page.getByLabel("Kod").fill(verificationCode(await waitForMail(email)));
  await page.getByRole("button", { name: "Fortsätt" }).click();
  // "Account activated": continue to the application.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Aktiverat/);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  await skipMfaPrompt(page);
  // Without a club: the home page with the onboarding placeholder.
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.goto("/me");
  await expect(page.getByTestId("me-name")).toHaveText("Inloggad som Emma Svensson");
  await expect(page.getByTestId("me-mfa")).toHaveText(/utan tvåstegsverifiering/);

  // Session fixation: the session cookie is new after login; tokens never reach the browser.
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "__Host-session");
  expect(session?.value).toBeTruthy();
  expect(session?.value).not.toBe(before);
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  expect(JSON.stringify(cookies)).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toMatch(/eyJ/);

  // The API knows the person through the BFF proxy (one account).
  const me: unknown = await page.evaluate(
    async () => (await fetch("/api/v1/me")).json() as Promise<unknown>,
  );
  expect(me).toMatchObject({
    person: { displayName: "Emma Svensson" },
    accountId: expect.any(String),
  });
});

test("signing up with the same email in other letter case is refused", async ({ page }) => {
  await signUp(page, email.toUpperCase());
  await expect(page.getByText(/finns redan|already|används redan|upptagen/i)).toBeVisible();
});

test("an MFA-gated endpoint answers mfa_required, and works after enrolling TOTP", async ({
  page,
}) => {
  await logIn(page, email);
  const without = await page.evaluate(async () => {
    const res = await fetch("/api/v1/me/security");
    return { status: res.status, body: (await res.json()) as { detail?: string } };
  });
  expect(without).toMatchObject({ status: 403, body: { detail: "mfa_required" } });

  const secret = await enrolTotp(email);
  await page.getByTestId("logout").click();
  await logIn(page, email, secret);
  await expect(page.getByTestId("me-mfa")).toHaveText(/med tvåstegsverifiering/);
  const status = await page.evaluate(async () => (await fetch("/api/v1/me/security")).status);
  expect(status).toBe(200);

  // Logout clears the server-side session: replaying the old cookie does not work.
  const cookie = (await page.context().cookies()).find((c) => c.name === "__Host-session")!;
  await page.getByTestId("logout").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/me"));
  await page.context().addCookies([cookie]);
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
});

test("Anna logs in with her email and the demo password (pnpm dev:idp-sync)", async ({ page }) => {
  await logIn(page, "anna.lindqvist@example.test", undefined, "demo-password-123");
  await expect(page.getByTestId("me-name")).toContainText("Anna Lindqvist");
});
