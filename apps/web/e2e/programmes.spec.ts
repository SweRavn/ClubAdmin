// SPDX-License-Identifier: AGPL-3.0-only
// Programmes and templates (P2.9) on the demo data: Erik opens SVK F2017's
// Höstcupen as a timeline per hall with its kiosk and score-table shifts,
// lays the template "Höstcupen" out on a new first day with a preview, and
// the new programme opens; Karin's club template "Städdag" is laid out for
// IK Norrbacka P2012 with its team mapped to the group.
import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test("the cup is a timeline per hall with its shifts", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/programmes` });
  await page.getByRole("link", { name: "Höstcupen i Strandviken", exact: true }).click();
  await expect(page.getByTestId("programme-title")).toHaveText("Höstcupen i Strandviken");
  const timeline = page.getByTestId("programme-timeline");
  await expect(timeline).toContainText("Strandvikshallen A");
  await expect(timeline).toContainText("Strandvikshallen B");
  await expect(timeline).toContainText("Höstcupen: gruppspel");
  await expect(timeline).toContainText("Kiosk – Höstcupen: gruppspel");
  await expect(timeline).toContainText("0 av 2");
});

test("a template is laid out on a new date with a preview, all at once", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/programmes` });
  await page.getByRole("link", { name: "Höstcupen", exact: true }).click();
  await expect(page.getByTestId("template-editions")).toContainText("Höstcupen");
  await page.getByTestId("programme-template-apply").click();
  await page.getByTestId("programme-first-day").fill(inDays(90));
  await page.getByTestId("programme-preview").click();
  const preview = page.getByTestId("programme-preview-result");
  await expect(preview).toContainText("Höstcupen: gruppspel");
  await expect(page.getByTestId("programme-refusals")).toHaveCount(0);
  await page.getByTestId("programme-confirm").click();
  await expect(page.getByTestId("notice")).toHaveText("Programmet är skapat.");
  await expect(page.getByTestId("programme-timeline")).toContainText("Strandvikshallen A");
});

test("a club template is laid out by a team for its own group", async ({ page }) => {
  await loginAs(page, PERSONAS.karin, { returnTo: `/clubs/${CLUBS.ikn}/programmes` });
  await page.getByRole("link", { name: "Städdag", exact: true }).click();
  await page.getByTestId("programme-template-apply").click();
  await page.getByTestId("programme-first-day").fill(inDays(30));
  await page.getByTestId(`programme-slot-lag-${GROUPS.iknP2012}`).check();
  await page.getByTestId("programme-preview").click();
  await expect(page.getByTestId("programme-preview-result")).toContainText("Städpass – första");
  await page.getByTestId("programme-confirm").click();
  await expect(page.getByTestId("notice")).toHaveText("Programmet är skapat.");
  await expect(page.getByTestId("programme-timeline")).toContainText("Fika");
});
