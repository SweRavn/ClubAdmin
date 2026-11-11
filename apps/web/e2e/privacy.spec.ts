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

// Consents are the registrar's (P1.15 A2): Anna is SVK's club manager and registrar.
test("the registrar sees who in a team has consented", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/groups/${GROUPS.svkF2017}/consents` });
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

// P1.8b: "download my data", account deletion and ward erasure.

test("a parent sees her expired data requests; another requests his own data", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/privacy" });
  // The seed's two requests from ten days ago, their files deleted.
  const exports = page.getByTestId("exports");
  await expect(exports.locator('[data-testid="data-export"][data-status="expired"]')).toHaveCount(
    2,
  );
  await expect(exports.getByTestId("download-export")).toHaveCount(0);

  // Henrik (not used by the notification tests: the file's notice is his).
  await loginAs(page, PERSONAS.henrik, { returnTo: "/me/privacy" });
  await page.getByTestId("request-export-self").click();
  await expect(page.getByText("Begärt. Du får en avisering när filen är klar.")).toBeVisible();
  await expect(page.getByTestId("exports").getByTestId("data-export")).toHaveCount(1);
});

test("deleting the account is refused while the coach owns a group, with the club named", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.ahmed, { returnTo: "/me/privacy/delete" });
  await expect(page.getByTestId("erasure-blockers")).toContainText("IK Norrbacka");
  await expect(page.getByTestId("blocker-roles_must_be_removed")).toBeVisible();
  await expect(page.getByTestId("schedule-deletion")).toBeDisabled();
});

test("a parent schedules her account deletion, sees the banner and cancels it", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.mikael, { returnTo: "/me/privacy/delete" });
  await page.getByTestId("confirm-deletion").check();
  await page.getByTestId("schedule-deletion").click();
  await expect(page.getByTestId("deletion-pending")).toBeVisible();
  await expect(page.getByTestId("deletion-banner")).toBeVisible();
  await page.getByTestId("cancel-deletion").click();
  await expect(page.getByText("Raderingen är avbruten.")).toBeVisible();
  await expect(page.getByTestId("deletion-banner")).toHaveCount(0);
});
