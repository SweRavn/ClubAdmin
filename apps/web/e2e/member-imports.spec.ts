// SPDX-License-Identifier: AGPL-3.0-only
// Adding and importing members (P1.3b) on the demo scenario: Johan (SVK
// registrar) adds a child with three guardians by hand and uploads the
// sample file; Karin (IKN club manager, with a second factor) reviews the
// seeded import, resolves the possible duplicate and imports it.

import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

const SAMPLE = fileURLToPath(
  new URL("../../../docs/demodata/imports/medlemmar.csv", import.meta.url),
);
const IKN_IMPORT = "0199a000-0000-7000-8010-000000000002";

test("Johan adds a child with three guardians by hand", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, { returnTo: `/clubs/${CLUBS.svk}/members/new` });
  const form = page.getByTestId("add-member-form");
  await page.getByTestId("add-givenName").fill("Lova");
  await page.getByTestId("add-familyName").fill("Strömberg");
  await page.getByTestId("add-birthDate").fill("2016-05-04");
  for (let i = 0; i < 3; i++) await page.getByTestId("add-guardian").click();
  await expect(form.getByTestId("guardian-fieldset")).toHaveCount(3);
  await page.getByTestId("guardian-0-given").fill("Petra");
  await page.getByTestId("guardian-0-family").fill("Strömberg");
  await page.getByTestId("guardian-1-email").fill(`ola-${Date.now()}@example.test`);
  await page.getByTestId("guardian-2-given").fill("Jonas");
  await page.getByTestId("guardian-2-family").fill("Ekström");
  await page.getByTestId("guardian-2-kind").selectOption("step_parent");
  await page.getByTestId("guardian-2-consent").fill("Ansökan 2025-08-12");
  await page.getByTestId("add-member-submit").click();
  await page.waitForURL(/added=1/);
  await expect(page.getByTestId("notice")).toBeVisible();
  await page.getByTestId("register-search").fill("Strömberg");
  await page.waitForURL(/q=Str/);
  await expect(page.getByTestId("register")).toContainText("Lova Strömberg");
});

test("Karin reviews IKN's import, decides the duplicate and imports it", async ({ page }) => {
  await loginAs(page, PERSONAS.karin, {
    returnTo: `/clubs/${CLUBS.ikn}/members/import?import=${IKN_IMPORT}`,
    mfa: true,
  });
  const imp = page.getByTestId("import");
  await expect(imp).toHaveAttribute("data-status", "review");
  await expect(page.getByTestId("import-summary")).toBeVisible();
  const duplicate = page.locator('[data-testid="import-row"][data-status="duplicate"]');
  await expect(duplicate).toContainText("Oskar");
  await duplicate.getByTestId("row-different_person").click();
  await expect(page.locator('[data-testid="import-row"][data-status="duplicate"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="import-row"][data-status="error"]')).toContainText(
    "Tove",
  );
  await page.getByTestId("import-confirm-submit").click();
  // The API's import job adds the members; the page reloads itself.
  await expect(imp).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(page.locator('[data-count="imported"] dd')).toHaveText("7");
});

test("Johan uploads the sample file and sees every row before anything is added", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.johan, {
    returnTo: `/clubs/${CLUBS.svk}/members/import`,
    mfa: true,
  });
  await page.getByTestId("import-file").setInputFiles(SAMPLE);
  await page.getByTestId("import-upload-submit").click();
  await page.waitForURL(/import=/);
  const imp = page.getByTestId("import");
  await expect(imp).toHaveAttribute("data-status", "review", { timeout: 30_000 });
  await expect(page.locator('[data-count="rows"] dd')).toHaveText("6");
  // SVK has no "Fotboll" or "Innebandy" groups: those rows are errors, with the reason.
  await expect(page.getByTestId("import-rows")).toContainText("Saga Öberg");
  await expect(page.getByTestId("row-issues").first()).toBeVisible();
  await page.getByTestId("import-cancel").locator("button").click();
  await page.waitForURL((url) => !url.searchParams.has("import"));
  await expect(page.getByTestId("imports")).toBeVisible();
});
