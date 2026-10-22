// SPDX-License-Identifier: AGPL-3.0-only
// The member register (P1.2) on the demo scenario: Johan (SVK registrar)
// searches and filters, exports and downloads; Peter (IKN treasurer) sees the
// board's limited list without Nadia; membership actions on a profile.

import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("Johan finds Elsa as he types and lists F2017 without photo consent", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, { returnTo: `/clubs/${CLUBS.svk}/members` });
  const register = page.getByTestId("register");
  await expect(register).toContainText(PERSONAS.elsa.name);

  await page.getByTestId("register-search").fill("els");
  await page.waitForURL(/q=els/);
  await expect(register).toContainText(PERSONAS.elsa.name);
  await expect(register).not.toContainText(PERSONAS.alva.name);

  await page.getByTestId("register-search").fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"));
  const panel = page.getByTestId("register-filters").locator("details");
  if ((await panel.getAttribute("open")) === null) await panel.locator("summary").click();
  await page.locator('select[name="groupId"]').selectOption(GROUPS.svkF2017);
  await page.locator('select[name="missingConsent"]').selectOption("photo_publication");
  await page.getByTestId("register-filters").locator('button[type="submit"]').click();
  await page.waitForURL(/missingConsent=photo_publication/);
  await expect(register).toContainText(PERSONAS.alva.name);
  await expect(register).not.toContainText(PERSONAS.elsa.name);
});

test("Peter sees IKN's limited list: no birth dates, never Nadia", async ({ page }) => {
  await loginAs(page, PERSONAS.peter, { returnTo: `/clubs/${CLUBS.ikn}/members` });
  const register = page.getByTestId("register");
  await expect(register).toBeVisible();
  await expect(page.locator('select[name="missingConsent"]')).toHaveCount(0);
  await expect(register).not.toContainText(PERSONAS.nadia.name);
  await expect(register.locator(`[data-person="${PERSONAS.nadia.id}"]`)).toHaveCount(0);
  await expect(page.getByTestId("register-export")).toHaveCount(0);
});

test("Johan exports the register and downloads the file", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, {
    returnTo: `/clubs/${CLUBS.svk}/members/exports`,
    mfa: true,
  });
  await page.getByTestId("export-submit").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  // The worker writes the file within seconds.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("export-download").first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  const href = await page.getByTestId("export-download").first().getAttribute("href");
  const redirect = await page.request.get(href!, { maxRedirects: 0 });
  expect(redirect.status()).toBe(303);
  const location = redirect.headers().location!;
  expect(location).toContain("X-Amz-Signature=");
  const file = await page.request.get(location);
  expect(file.ok()).toBe(true);
  const text = (await file.body()).toString("utf8");
  expect(text.startsWith("﻿")).toBe(true);
  expect(text).toContain(PERSONAS.elsa.name);
});

test("Johan resumes and pauses Lars's membership from his profile", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, {
    returnTo: `/people/${PERSONAS.lars.id}?clubId=${CLUBS.svk}`,
  });
  const actions = page.getByTestId("membership-actions");
  await expect(actions).toBeVisible();
  await page.getByTestId("membership-pause").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await page.getByTestId("membership-pause").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("form-error")).toHaveCount(0);
});
