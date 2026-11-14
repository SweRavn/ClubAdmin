// SPDX-License-Identifier: AGPL-3.0-only
// Announcements (P2.3) on the demo data: Göran (IK Norrbacka's club
// manager) writes a club announcement for the board; Anna (Oskar's parent)
// finds it on "Anslagstavlan" under the pinned annual meeting, unread,
// reads it (the text as Markdown) and it is read. Delivery by push and
// email is covered by the worker's integration tests.

import { expect, test } from "@playwright/test";

import { loginAs, PERSONAS } from "./personas.ts";

const GORAN = { id: "0199a000-0000-7000-8000-000000000037", name: "Göran Lund" };
const IKN = "0199a000-0000-7000-8001-000000000002";

test("a club announcement on the board, read by a parent", async ({ page, context }) => {
  await loginAs(page, GORAN, { returnTo: `/clubs/${IKN}/announcements/new` });
  const composer = page.getByTestId("announcement-composer");
  await composer.getByLabel("Rubrik").fill("Städdag i klubbstugan");
  await composer
    .getByLabel("Text")
    .fill("Vi städar **lördag** kl. 10.\n\n- Ta med handskar\n- Fika finns");
  // Only the board: no push or email from the test.
  await composer.locator('input[name="channel"][value="push"]').uncheck();
  await composer.getByTestId("send-announcement").click();
  await expect(page).toHaveURL(/\/clubs\/[0-9a-f-]{36}\/announcements\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("announcement-body").locator("strong")).toHaveText("lördag");
  await expect(page.getByTestId("announcement-manage")).toContainText("Skickat");

  await context.clearCookies();
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/announcements" });
  await expect(page.getByTestId("pinned")).toContainText("Kallelse till årsmöte 12 mars");
  const row = page.getByTestId("announcements").locator("li", { hasText: "Städdag i klubbstugan" });
  await expect(row).toHaveAttribute("data-unread", "true");
  await row.getByRole("link", { name: "Städdag i klubbstugan" }).click();
  await expect(page.getByTestId("announcement-body").locator("li")).toHaveCount(2);
  await page.goto("/me/announcements");
  await expect(
    page.getByTestId("announcements").locator("li", { hasText: "Städdag i klubbstugan" }),
  ).toHaveAttribute("data-unread", "false");
});
