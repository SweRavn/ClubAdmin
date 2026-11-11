// SPDX-License-Identifier: AGPL-3.0-only
// At least two administrators (P1.15 A3): who counts, the club's state
// (FIL has two and sees the recommendation of a third; Lövsta BTK is in its
// grace period), and two administrators suspending a third.
import { expect, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

test("SVK's administrators: three count; the suspended one is not among them", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/clubs/${CLUBS.svk}/administrators` });
  const list = page.getByTestId("administrators");
  await expect(list).toBeVisible();
  for (const p of [PERSONAS.anna, PERSONAS.sara, PERSONAS.mats]) {
    await expect(list.getByTestId("administrator").filter({ hasText: p.name })).toContainText(
      "Räknas",
    );
  }
  await expect(list).not.toContainText(PERSONAS.linnea.name);
  await expect(page.getByTestId("administrators-needed")).toHaveCount(0);
});

test("FIL is advised to appoint a third; Lövsta BTK has a deadline", async ({ page }) => {
  await loginAs(page, PERSONAS.lars, { returnTo: `/clubs/${CLUBS.fil}` });
  await expect(page.getByTestId("administrators-recommend-third")).toBeVisible();
  await loginAs(page, PERSONAS.ulf, { returnTo: `/clubs/${CLUBS.lbtk}` });
  await expect(page.getByTestId("administrators-grace")).toContainText("senast");
});

test("two administrators suspend a third", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, {
    returnTo: `/clubs/${CLUBS.svk}/administrators`,
    mfa: true,
  });
  const mats = page.getByTestId("administrator").filter({ hasText: PERSONAS.mats.name });
  await mats.getByText("Stäng av som föreningsadministratör").click();
  await mats.getByLabel("Skäl").selectOption("left_task");
  await mats.getByRole("checkbox").uncheck();
  await mats.getByRole("button", { name: "Begär avstängning" }).click();
  await expect(page.getByText("Begäran är skickad.")).toBeVisible();
  // Sara asked for it: she cannot confirm, only withdraw.
  const request = page.getByTestId("suspension");
  await expect(request.getByRole("button", { name: "Bekräfta avstängningen" })).toHaveCount(0);
  await expect(request.getByRole("button", { name: "Dra tillbaka begäran" })).toBeVisible();

  await loginAs(page, PERSONAS.anna, {
    returnTo: `/clubs/${CLUBS.svk}/administrators`,
    mfa: true,
  });
  await page
    .getByTestId("suspension")
    .getByRole("button", { name: "Bekräfta avstängningen" })
    .click();
  await expect(page.getByText("Avstängningen är bekräftad och gäller direkt.")).toBeVisible();
  await expect(page.getByTestId("administrators")).not.toContainText(PERSONAS.mats.name);
  await expect(page.getByTestId("administrators-recommend-third")).toBeVisible();
});
