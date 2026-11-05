// SPDX-License-Identifier: AGPL-3.0-only
// History and the audit log (P1.9, ADR 0042) on the demo data: the
// registrar opens Elsa's history from her profile (Johan's own membership
// type change, Anna's move to F2017), a coach sees no history link, and a
// club manager with a second factor reads the club's audit log by category.

import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("the registrar opens a member's history from the profile", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, {
    returnTo: `/people/${PERSONAS.elsa.id}?clubId=${CLUBS.svk}`,
  });
  await page.getByTestId("history-link").click();
  await page.waitForURL((url) => url.pathname === `/people/${PERSONAS.elsa.id}/history`);
  const list = page.getByTestId("history-list");
  await expect(list).toBeVisible();
  // Johan changed Elsa's membership type last month; Anna moved her to F2017.
  await expect(list.locator('[data-resource="club_membership"]').first()).toContainText(
    "Medlemskap",
  );
  await expect(list).toContainText("F2017");
  await expect(list).toContainText("Johan Nilsson");
  await expect(page.getByText("Historiken sparas i 24 månader.")).toBeVisible();
});

test("a coach sees no history link on the group", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await expect(page.getByTestId("group-name")).toBeVisible();
  await expect(page.getByTestId("history-link")).toHaveCount(0);
});

test("a club manager reads the audit log by category", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/clubs/${CLUBS.svk}/audit`, mfa: true });
  const table = page.getByTestId("audit-table");
  await expect(table).toBeVisible();
  await page.getByLabel("Kategori").selectOption("roles");
  await page.getByRole("button", { name: "Filtrera" }).click();
  await expect(page.getByTestId("audit-entry").first()).toBeVisible();
  for (const action of await page.getByTestId("audit-entry").evaluateAll((rows) =>
    rows.map((r) => r.getAttribute("data-action")),
  )) {
    expect(action).toMatch(/^(club\.role|club\.manager|group\.owner)\./);
  }
});
