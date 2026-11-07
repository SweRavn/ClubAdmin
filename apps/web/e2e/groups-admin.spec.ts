// SPDX-License-Identifier: AGPL-3.0-only
// Group administration (P1.10a) on the demo data: a club manager adds a
// leader to a team and ends the function again, the archive page tells what
// archiving would end (without archiving), and an owner without the
// co-owner setting cannot appoint owners.

import { expect, test } from "@playwright/test";

import { GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("a club manager adds a leader to a team and ends the function", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/groups/${GROUPS.svkHerr}/manage` });
  const members = page.getByTestId("group-members-admin");
  await expect(members).toBeVisible();
  await page.getByTestId("member-search").fill("Lars");
  await members.locator("select[name=function]").selectOption("other_leader");
  await members.getByRole("button", { name: "Sök" }).click();
  await page.getByTestId("add-member").first().click();
  await expect(page.getByText("Tillagd i gruppen.")).toBeVisible();
  const lars = page
    .getByTestId("group-members-admin")
    .locator("li", { has: page.locator(`[data-person-id="${PERSONAS.lars.id}"]`) });
  await expect(lars).toContainText("Ledare");
  await lars.locator("span", { hasText: "Ledare" }).getByTestId("end-membership").click();
  await expect(page.getByText("Funktionen har avslutats.")).toBeVisible();
});

test("the archive page tells what archiving ends", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/groups/${GROUPS.svkF2017}/archive` });
  const preview = page.getByTestId("archive-preview");
  await expect(preview).toContainText("spelare lämnar den");
  await expect(preview).toContainText("ledare lämnar den");
  await expect(page.getByTestId("group-archive-confirm")).toBeVisible();
});

test("an owner without the co-owner setting cannot appoint owners", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/manage` });
  await expect(page.getByTestId("group-owners")).toBeVisible();
  await expect(page.getByTestId("owner-search")).toHaveCount(0);
  await expect(page.getByTestId("member-search")).toBeVisible();
});
