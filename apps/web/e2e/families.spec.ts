// SPDX-License-Identifier: AGPL-3.0-only
// Families (P1.3) on the demo scenario: Anna merges the duplicate Elsa and
// undoes it; Sara gives Vera her own login, changes Gunilla's rights and
// links a contact person without login to Alva; Gunilla ends her own link;
// Tilde decides at the adult age; Johan records a contact person from a paper
// form; Emma links a helper to herself; an unknown invitation link says so.

import { expect, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

test("Anna sees Elsa twice, merges and undoes it", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/family" });
  const pair = page.getByTestId("duplicate-pair");
  await expect(pair).toHaveCount(1);
  await expect(pair).toContainText(PERSONAS.elsa.name);
  await pair.getByTestId("merge").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("duplicate-pair")).toHaveCount(0);
  await page.getByTestId("undo-merge").getByTestId("undo").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("duplicate-pair")).toHaveCount(1);
});

test("Sara gives Vera her own login, changes Gunilla's rights and links a neighbour to Alva", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.sara, { returnTo: "/me/family" });
  const vera = page.locator(`[data-testid="ward"][data-person="${PERSONAS.vera.id}"]`);
  await vera.getByTestId("open-own-login").click();
  await vera.getByTestId("own-login-email").fill("vera.ahmed@example.test");
  await vera.getByTestId("own-login-submit").click();
  await expect(page.getByTestId("notice")).toBeVisible();

  const alva = page.locator(`[data-testid="ward"][data-person="${PERSONAS.alva.id}"]`);
  const gunilla = alva.locator(`[data-testid="guardian"][data-person="${PERSONAS.gunilla.id}"]`);
  await gunilla.locator("summary").click();
  await gunilla.getByTestId("right-receive_messages").check();
  await gunilla.getByTestId("save-rights").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(
    page
      .locator(`[data-testid="ward"][data-person="${PERSONAS.alva.id}"]`)
      .locator(`[data-testid="guardian"][data-person="${PERSONAS.gunilla.id}"]`)
      .getByTestId("guardian-rights"),
  ).toContainText(/meddelanden/i);

  const ward = page.locator(`[data-testid="ward"][data-person="${PERSONAS.alva.id}"]`);
  await ward.getByTestId("open-invite").click();
  const form = ward.getByTestId("link-form");
  await form.getByTestId("link-given").fill("Kim");
  await form.getByTestId("link-family").fill("Skjutsare");
  await form.getByTestId("link-submit").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(
    page.locator(`[data-testid="ward"][data-person="${PERSONAS.alva.id}"]`),
  ).toContainText("Kim Skjutsare");
});

test("Gunilla sees what is shared with her and ends her own link", async ({ page }) => {
  await loginAs(page, PERSONAS.gunilla, { returnTo: "/me/family" });
  const shared = page.getByTestId("shared-with-me");
  await expect(shared).toContainText(PERSONAS.alva.name);
  await shared.locator('input[name="confirm"]').check();
  await shared.getByTestId("end-guardianship").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("shared-with-me")).toHaveCount(0);
});

test("Tilde keeps one guardian and ends the other at the adult age", async ({ page }) => {
  await loginAs(page, PERSONAS.tilde, { returnTo: "/me/family/adult" });
  const rows = page.getByTestId("adult-guardian");
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByTestId("adult-keep").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await page.getByTestId("adult-guardian").nth(1).getByTestId("adult-end").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("adult-guardian")).toHaveCount(1);
});

test("Johan records a contact person for Alva from a paper form", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, {
    returnTo: `/people/${PERSONAS.alva.id}?clubId=${CLUBS.svk}`,
  });
  const section = page.getByTestId("club-guardians");
  await section.getByTestId("open-club-guardian").click();
  const form = section.getByTestId("club-guardian-form");
  await form.locator('input[name="givenName"]').fill("Pia");
  await form.locator('input[name="familyName"]').fill("Hämtar");
  await form.getByTestId("consent-note").fill("Blankett underskriven av Sara 2026-10-01");
  await form.getByTestId("club-guardian-submit").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("club-guardians")).toContainText("Pia Hämtar");
  await expect(page.getByTestId("club-guardians")).toContainText("Blankett underskriven");
});

test("Emma links a contact person to herself", async ({ page }) => {
  await loginAs(page, PERSONAS.emma, { returnTo: "/me/family" });
  const helpers = page.getByTestId("trusted-people");
  await expect(helpers).toContainText("Bo Stöd");
  await helpers.getByTestId("open-helper").click();
  const form = helpers.getByTestId("link-form");
  await form.getByTestId("link-given").fill("Ulla");
  await form.getByTestId("link-family").fill("Stödperson");
  await form.getByTestId("link-submit").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("trusted-people")).toContainText("Ulla Stödperson");
});

test("an unknown invitation link says it is not valid", async ({ page }) => {
  await page.goto("/guardian-invitations/this-is-not-a-real-invitation-token-at-all");
  await expect(page.getByTestId("guardian-invitation-invalid")).toBeVisible();
});
