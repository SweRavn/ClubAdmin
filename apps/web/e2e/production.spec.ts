// SPDX-License-Identifier: AGPL-3.0-only
// Checks against the production build (E2E_PRODUCTION=1, `next build && next
// start` behind Caddy): the strict CSP without any relaxation, Trusted
// Types, security headers, and no CSP violations while pages run.

import { expect, type Page, test } from "@playwright/test";

import { createTestSession } from "../scripts/test-session.ts";
import { CLUBS, GROUPS, PERSONAS } from "./personas.ts";

async function signIn(page: Page, personId: string): Promise<void> {
  const { id, csrf } = await createTestSession(personId);
  // __Host- cookies have no Domain attribute: set them by URL.
  const url = test.info().project.use.baseURL ?? "https://clubadmin.localhost";
  await page.context().addCookies([
    { name: "__Host-session", value: id, url, secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-csrf", value: csrf, url, secure: true, sameSite: "Lax" },
  ]);
}

/** Console messages about blocked content (CSP or Trusted Types). */
function violations(page: Page): string[] {
  const found: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Trusted ?Type/i.test(message.text())) found.push(message.text());
  });
  return found;
}

test("strict CSP with Trusted Types and the security headers", async ({ page }) => {
  const response = await page.goto("/login");
  const headers = response!.headers();
  const csp = headers["content-security-policy"]!;
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toMatch(/style-src 'self' 'nonce-[^']+'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(headers).toMatchObject({
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
  });
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("signed-in pages run without CSP or Trusted Types violations", async ({ page }) => {
  const blocked = violations(page);
  await signIn(page, PERSONAS.erik.id);
  for (const url of ["/", `/clubs/${CLUBS.ikn}`, `/groups/${GROUPS.iknF2015}`, "/me/sessions"]) {
    await page.goto(url);
    await expect(page.getByTestId("user-menu"), url).toBeVisible();
  }
  // Client components work: the menu (Radix, loaded on first use) and the
  // protected-identity tooltip (Erik coaches Nadia's group).
  await page.getByTestId("user-menu").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`/groups/${GROUPS.iknF2015}`);
  await page.getByTestId("protected-badge").first().hover();
  await expect(page.getByRole("tooltip").first()).toBeVisible();
  expect(blocked).toEqual([]);
});

test("interactions paint within 200 ms (INP) on a slowed-down CPU", async ({ page }) => {
  await signIn(page, PERSONAS.erik.id);
  // Like Lighthouse's mobile profile: 4× CPU slowdown.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(`/groups/${GROUPS.iknF2015}`);
  await page.evaluate(() => {
    const w = window as unknown as { inp: number; interactions: Set<number> };
    w.inp = 0;
    w.interactions = new Set();
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (!entry.interactionId) continue;
        w.interactions.add(entry.interactionId);
        w.inp = Math.max(w.inp, entry.duration);
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  });
  // Opening the menus (the first click also loads Radix UI), closing them, the tooltip.
  for (const testId of ["user-menu", "club-switcher"]) {
    await page.getByTestId(testId).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await page.getByTestId("protected-badge").first().focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const { inp, count } = await page.evaluate(() => {
    const w = window as unknown as { inp: number; interactions: Set<number> };
    return { inp: w.inp, count: w.interactions.size };
  });
  console.log(`INP ${inp} ms over ${count} interactions`);
  expect(count).toBeGreaterThanOrEqual(4);
  expect(inp, "slowest interaction (ms)").toBeLessThan(200);
});
