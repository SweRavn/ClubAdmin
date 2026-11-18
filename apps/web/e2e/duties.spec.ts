// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6, ADR 0050) on the demo data in IK Norrbacka P2012:
// the home match's kiosk and score-table shifts on the activity, Anna's
// quota and Ahmed's offered shift in "Mina uppgifter", the leaders' page
// with the quota and last week's kiosk to mark, and the club's duty types
// (no "alone with children" in Sweden).

import { expect, test } from "@playwright/test";

import { GROUPS, loginAs, PERSONAS } from "./personas.ts";

const IKN = "0199a000-0000-7000-8001-000000000002";
const HOME_MATCH = "0199a000-0000-7000-8015-000000000020";

test("the family sees the home match's shifts, its quota and an offered shift", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/activities/${HOME_MATCH}` });
  const duties = page.getByTestId("activity-duties");
  await expect(duties).toContainText("Kiosk – hemmamatch");
  await expect(duties).toContainText("Sekretariat – hemmamatch");
  await expect(duties).toContainText("0 av 1");

  await page.goto(`/me/tasks?clubId=${IKN}`);
  await expect(page.getByTestId("duty-clubs")).toContainText("Norrbacka");
  const mine = page.getByTestId("my-duties");
  await expect(mine.getByTestId("duty-quotas")).toContainText("Oskar");
  await expect(mine.getByTestId("duty-swaps")).toContainText("Erbjuds");
  await expect(mine.getByTestId("duty-open-shifts")).toContainText("Sekretariat");
});

test("the leader marks last week's kiosk done and sees the quota", async ({ page }) => {
  await loginAs(page, PERSONAS.ahmed, { returnTo: `/groups/${GROUPS.iknP2012}/duties` });
  await expect(page.getByTestId("group-shift").first()).toBeVisible();
  await expect(page.getByTestId("duty-quota-input")).toHaveValue("2");
  const toMark = page.getByTestId("duties-to-mark");
  await expect(toMark).toContainText("Anna");
  await toMark.getByTestId("duty-mark-done").first().click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("duties-to-mark")).toHaveCount(0);
  await expect(page.getByTestId("duty-quota")).toContainText("Oskar");
});

test("the club's duty types without 'alone with children' in Sweden", async ({ page }) => {
  await loginAs(page, PERSONAS.karin, { returnTo: `/clubs/${IKN}/duties` });
  await expect(page.getByTestId("duty-types")).toBeVisible();
  await expect(page.getByTestId("duty-type-name").first()).toHaveValue("Kiosk");
  await expect(page.locator('option[value="alone_with_children"]')).toHaveCount(0);
  await expect(page.getByTestId("duty-settings")).toBeVisible();
});
