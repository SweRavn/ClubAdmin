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
