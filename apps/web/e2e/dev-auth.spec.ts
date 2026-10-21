// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH persona login, session revocation across browsers, and the
// security checklist: open redirects, CSRF.

import { expect, type Page, test } from "@playwright/test";

async function devLogin(
  page: Page,
  options: { mfa?: boolean; returnTo?: string } = {},
): Promise<string> {
  await page.goto(
    `/auth/login${options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : ""}`,
  );
  if (options.mfa) await page.getByLabel(/tvåstegsverifiering/).check();
  const button = page.getByRole("button", { name: /^Logga in som / }).first();
  const label = (await button.textContent()) ?? "";
  await button.click();
  return label.replace(/^Logga in som /, "");
}

test("log in as a persona from the picker; MFA can be toggled", async ({ page }) => {
  const name = await devLogin(page);
  await page.waitForURL("**/me");
  await expect(page.getByTestId("dev-banner")).toContainText(name);
  await expect(page.getByTestId("me-name")).toHaveText(`Inloggad som ${name}`);
  expect(await page.evaluate(async () => (await fetch("/api/v1/me/security")).status)).toBe(403);

  await devLogin(page, { mfa: true });
  await page.waitForURL("**/me");
  expect(await page.evaluate(async () => (await fetch("/api/v1/me/security")).status)).toBe(200);
});

test("revoking a session logs that browser out on its next request", async ({ browser }) => {
  const first = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const second = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const a = await first.newPage();
  const b = await second.newPage();
  await devLogin(a);
  await devLogin(b);
  await b.waitForURL("**/me");
  // B's own entry is the one marked as this browser.
  const handle = await b
    .getByTestId("sessions")
    .locator("li", { hasText: "Den här webbläsaren" })
    .getAttribute("data-session-id");
  await a.goto("/me");
  await a.locator(`li[data-session-id="${handle}"]`).getByRole("button").click();
  await a.waitForURL("**/me");
  await expect(a.locator(`li[data-session-id="${handle}"]`)).toHaveCount(0);

  await b.reload();
  await expect(b).toHaveURL(/\/auth\/login/);
  await first.close();
  await second.close();
});

test("returnTo cannot send the browser to another site", async ({ page }) => {
  for (const target of ["//evil.example/", "https://evil.example/", "/\\evil.example"]) {
    await devLogin(page, { returnTo: target });
    await page.waitForURL("**/me");
    expect(new URL(page.url()).hostname).toBe("clubadmin.localhost");
    expect(new URL(page.url()).pathname).toBe("/me");
  }
});

test("state-changing requests need the CSRF token", async ({ page }) => {
  await devLogin(page);
  await page.waitForURL("**/me");
  const withoutToken = await page.evaluate(
    async () => (await fetch("/api/v1/me/sessions/none", { method: "DELETE" })).status,
  );
  expect(withoutToken).toBe(403);
  const withToken = await page.evaluate(async () => {
    const csrf =
      document.cookie
        .split("; ")
        .find((c) => c.startsWith("__Host-csrf="))
        ?.split("=")[1] ?? "";
    return (
      await fetch("/api/v1/me/sessions/none", {
        method: "DELETE",
        headers: { "x-csrf-token": csrf },
      })
    ).status;
  });
  expect(withToken).toBe(404);
  // Logout from another site is refused.
  const crossSite = await page.request.post("/auth/logout", {
    headers: { origin: "https://evil.example" },
    form: { csrf: "x" },
  });
  expect(crossSite.status()).toBe(403);
});
