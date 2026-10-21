// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH persona login, session revocation across browsers, and the
// security checklist: open redirects, CSRF.

import { expect, type Page, test } from "@playwright/test";

import { loginAs, PERSONAS } from "./personas.ts";

const anna = PERSONAS.anna;

async function devLogin(page: Page, options: { mfa?: boolean; returnTo?: string } = {}) {
  await loginAs(page, anna, { returnTo: "/me", ...options });
}

test("log in as a persona from the picker; MFA can be toggled", async ({ page }) => {
  await page.goto("/login");
  // The picker groups personas by club, with the demo data's descriptions and tags.
  await expect(page.getByRole("group", { name: "Strandvikens Volleybollklubb" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Utan förening" })).toContainText("Emma Svensson");
  await devLogin(page);
  await expect(page.getByTestId("dev-banner")).toContainText(anna.name);
  await expect(page.getByTestId("me-name")).toHaveText(`Inloggad som ${anna.name}`);
  expect(await page.evaluate(async () => (await fetch("/api/v1/me/security")).status)).toBe(403);

  await devLogin(page, { mfa: true });
  expect(await page.evaluate(async () => (await fetch("/api/v1/me/security")).status)).toBe(200);
});

test("revoking a session logs that browser out on its next request", async ({ browser }) => {
  const first = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const second = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const a = await first.newPage();
  const b = await second.newPage();
  await loginAs(a, anna, { returnTo: "/me/sessions" });
  await loginAs(b, anna, { returnTo: "/me/sessions" });
  // B's own entry is the one marked as this browser.
  const handle = await b
    .getByTestId("sessions")
    .locator("li", { hasText: "Den här webbläsaren" })
    .getAttribute("data-session-id");
  await a.goto("/me/sessions");
  await a.locator(`li[data-session-id="${handle}"]`).getByRole("button").click();
  await a.waitForURL("**/me/sessions");
  await expect(a.locator(`li[data-session-id="${handle}"]`)).toHaveCount(0);

  await b.reload();
  await expect(b).toHaveURL(/\/login/);
  await first.close();
  await second.close();
});

test("returnTo cannot send the browser to another site", async ({ page }) => {
  for (const target of ["//evil.example/", "https://evil.example/", "/\\evil.example"]) {
    await page.goto(`/login?returnTo=${encodeURIComponent(target)}`);
    await page
      .getByRole("button", { name: `Logga in som ${anna.name}` })
      .first()
      .click();
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).hostname).toBe("clubadmin.localhost");
  }
});

test("state-changing requests need the CSRF token", async ({ page }) => {
  await devLogin(page);
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
  // Logout and "viewing as" from another site are refused.
  for (const action of ["/auth/logout", "/me/viewing-as", "/me/preferences/save"]) {
    const crossSite = await page.request.post(action, {
      headers: { origin: "https://evil.example" },
      form: { csrf: "x" },
    });
    expect(crossSite.status(), action).toBe(403);
  }
});

test("the old login URL redirects to /login", async ({ page }) => {
  await page.goto("/auth/login?returnTo=%2Fme");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fme$/);
});
