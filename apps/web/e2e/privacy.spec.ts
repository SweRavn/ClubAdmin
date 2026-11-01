// SPDX-License-Identifier: AGPL-3.0-only
// Privacy (P1.8a) on the demo data: Anna's consents (Elsa's photo consent
// was given for SVK's first text, so the club has a new one; Anna shows her
// phone to the team and withdraws it), SVK's privacy policy (version 2,
// decided by the board), a group's consent overview for a club manager,
// and leaving refused while a coach still has assignments.

import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("a parent sees the club's new text, and withdraws and gives her own contact consent", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/privacy" });
  const svk = page.getByTestId(`consents-${CLUBS.svk}`);
  await expect(svk).toBeVisible();
  await expect(svk.getByTestId(/consent-.*-photo_publication/).first()).toBeVisible();
  await expect(svk).toContainText("Klubben har en ny text");

  const anna = PERSONAS.anna.id;
  await svk.getByTestId(`withdraw-${anna}-contacts_group`).click();
  await expect(page.getByText("Samtycket är tillbakataget.")).toBeVisible();
  await page
    .getByTestId(`consents-${CLUBS.svk}`)
    .getByTestId(`give-${anna}-contacts_group`)
    .click();
  await expect(page.getByText("Samtycket är givet.")).toBeVisible();
});

test("the club's privacy policy shows the board's decision", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/privacy` });
  await expect(page.getByTestId("privacy-policy")).toContainText("version 2");
  await expect(
    page.getByTestId("privacy-rules").locator('tr[data-setting="former_member_retention_months"]'),
  ).toContainText("Beslutat av styrelsen");
});

test("a club manager sees who in a team has consented", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/groups/${GROUPS.svkF2017}/consents` });
  await expect(page.getByTestId("consent-table")).toBeVisible();
  await expect(page.getByTestId("consent-counts")).toContainText("Publicering av foto");
});

test("leaving is refused while the person still has assignments", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, {
    returnTo: `/me/privacy/leave?clubId=${CLUBS.svk}&personId=${PERSONAS.erik.id}`,
  });
  await expect(page.getByTestId("leave-assignments")).toBeVisible();
  await expect(page.getByTestId("leave-form")).toHaveCount(0);
});
