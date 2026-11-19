// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles (P1.15 A2): the roles page explains each role, a club
// manager changes one through the preview, the help explains how roles
// work, and everyone sees their own roles.
import { expect, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

test("a club manager sees the club's roles, including SVK's own", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/clubs/${CLUBS.svk}/roles` });
  const roles = page.getByTestId("roles-page");
  await expect(roles).toBeVisible();
  // The demo: SVK renamed its team managers and has its own group role.
  await expect(roles.getByTestId("role-card").filter({ hasText: "Lagansvarig" })).toHaveCount(1);
  await expect(roles.getByTestId("role-card").filter({ hasText: "Materialansvarig" })).toHaveCount(
    1,
  );
  // Sara does not hold the registrar role: the page offers it.
  await expect(page.getByTestId("manager-split")).toContainText("Medlemsansvarig");
});

test("changing a role goes through a preview of who loses what", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/clubs/${CLUBS.svk}/roles`, mfa: true });
  await page.getByRole("link", { name: "Materialansvarig" }).click();
  const form = page.getByTestId("role-form");
  await expect(form).toBeVisible();
  await form.getByLabel("Planera gruppens aktiviteter").uncheck();
  await form.getByRole("button", { name: "Förhandsgranska ändringen" }).click();
  const preview = page.getByTestId("role-preview");
  await expect(preview).toContainText("Rollen förlorar: Planera gruppens aktiviteter");
  await expect(preview).toContainText("1 person kan inte längre");
  await preview.getByRole("button", { name: "Spara ändringen" }).click();
  await expect(page.getByText("Ändringen är sparad.")).toBeVisible();
  await expect(page.getByTestId("role-reaches")).toContainText("Ger inga behörigheter");
});

test("the help explains roles; a member sees their own roles", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: "/me/roles" });
  const mine = page.getByTestId("my-roles");
  await expect(mine).toContainText("Huvudtränare");
  await mine.getByRole("link", { name: "Så fungerar roller" }).click();
  await expect(page.getByTestId("roles-help")).toContainText("inte i dess undergrupper");
});

test("a chess club's roles come from its type; the template is shown to compare", async ({
  page,
}) => {
  // P1.15 B: Ekuddens Schackklubb is of the type "Schackklubb".
  await loginAs(page, PERSONAS.britt, { returnTo: `/clubs/${CLUBS.esk}/roles` });
  const cards = page.getByTestId("role-card");
  await expect(cards.filter({ hasText: "Turneringsledare" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "Spelare" })).toHaveCount(1);
  const template = page.getByTestId("template-roles");
  await expect(template).toContainText("Schackklubb");
  await expect(template.getByTestId("template-role")).toHaveCount(5);
});

test("the operator sees the club types and a type's template", async ({ page }) => {
  // P1.15 B: /ops/club-types needs an operator with a second factor.
  await loginAs(page, PERSONAS.operator, { returnTo: "/ops/club-types", mfa: true });
  const types = page.getByTestId("club-type");
  await expect(types.filter({ hasText: "Idrottsförening" })).toHaveCount(1);
  await types.filter({ hasText: "Schackklubb" }).getByRole("link").click();
  await expect(page.getByTestId("club-type-role")).toHaveCount(5);
  await expect(page.getByTestId("club-type-page")).toContainText("Turneringsledare");
});

test("Karin finds Administration, gives a role in the role matrix and ends it (P2.7c)", async ({
  page,
}) => {
  // Changing roles needs the second factor (as on the person's page).
  await loginAs(page, PERSONAS.karin, { returnTo: `/clubs/${CLUBS.ikn}`, mfa: true });
  await page.getByTestId("nav-administration").click();
  await expect(page.getByTestId("administration")).toBeVisible();
  await page.getByTestId("administration-link-matrix").click();
  await expect(page.getByTestId("role-matrix")).toBeVisible();
  // Ahmed holds no club role: found by name and added as a row.
  await page.getByTestId("role-matrix-search").fill("Ahmed");
  await page.getByTestId("role-matrix-add").first().click();
  const row = page.locator(`[data-testid="role-matrix-row"][data-person="${PERSONAS.ahmed.id}"]`);
  await expect(row).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });
  const cell = row.getByRole("button", { name: /Kassör/ });
  await expect(cell).toHaveAttribute("aria-pressed", "false");
  await cell.click();
  await expect(row.getByRole("button", { name: /Kassör: har rollen/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The arrow keys move between cells.
  await row.getByRole("button", { name: /Kassör/ }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(row.getByRole("button", { name: /Kassör/ })).not.toBeFocused();
  // Ended again with one more tap, in place.
  await row.getByRole("button", { name: /Kassör/ }).click();
  await expect(row.getByRole("button", { name: /Kassör: har inte rollen/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );
  // Breadcrumbs: Förening › Administration › page.
  await expect(page.getByRole("navigation", { name: "Brödsmulor" })).toContainText(
    "Administration",
  );
});
