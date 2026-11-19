// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports in the web app (P2.7 part C): Anna (SVK's club manager and
// registrar) checks the club's LOK plugin with a second factor, opens this
// half-year's LOK report with what counts and why, locks it and downloads
// its CSV file.
import { expect, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

const now = new Date();
const period = `${now.getUTCFullYear()}-${now.getUTCMonth() < 6 ? 1 : 2}`;

test("Anna sees SVK's LOK plugin and its settings (second factor)", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/plugins`, mfa: true });
  const lok = page.getByTestId("plugin-se.rf.lok");
  await expect(lok).toBeVisible();
  await expect(page.getByTestId("plugin-enabled-se.rf.lok")).toBeChecked();
  await page.getByTestId("plugin-save-se.rf.lok").click();
  await expect(page.getByTestId("notice")).toBeVisible();
});

test("Anna locks this half-year's LOK report and downloads its CSV file", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/grants` });
  await expect(page.getByTestId("grant-scheme")).toHaveCount(1);
  await page.getByTestId(`grant-period-${period}`).click();
  await page.waitForURL(/period=/);
  const report = page.getByTestId("grant-report");
  await expect(report).toBeVisible();
  await expect(page.getByTestId("grant-report-status")).toContainText("Utkast");
  await expect(page.getByTestId("grant-session").first()).toBeVisible();

  await page.getByTestId("grant-lock").click();
  await expect(page.getByTestId("notice")).toHaveText("Rapporten är låst.");
  await expect(page.getByTestId("grant-report-status")).toContainText("Låst");

  const download = page.waitForEvent("download");
  await page.getByTestId("grant-export").click();
  expect((await download).suggestedFilename()).toBe(`lok-${period}.csv`);
});
