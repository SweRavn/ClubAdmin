// SPDX-License-Identifier: AGPL-3.0-only
// Waiting lists (P1.10b) on the demo data, read only: Henrik sees Viktor's
// place ("Number 2 of 5") on /me/waitlists, Erik as owner of F2017 sees the
// queue in order with the open offer, and Sara as club manager sees the
// out-of-turn admission with its reason. The search shows F2017 as open for
// applications ("full").

import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("a parent sees the child's place in the queue", async ({ page }) => {
  await loginAs(page, PERSONAS.henrik, { returnTo: "/me/waitlists" });
  const entry = page.getByTestId("my-waitlist-entry").first();
  await expect(entry).toContainText("Nummer 2 av 5");
  await expect(entry.getByTestId("leave-waitlist")).toBeVisible();
});

test("an owner sees the waiting list in order with the offer out", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/waitlist` });
  await expect(page.getByTestId("waitlist-summary")).toContainText("5 i kön");
  const positions = page.getByTestId("waitlist-position");
  await expect(positions.first()).toHaveText("Nummer 1 av 5");
  await expect(page.getByTestId("waitlist-offer")).toContainText("svar senast");
});

test("a club manager sees the out-of-turn admission with its reason", async ({ page }) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/clubs/${CLUBS.svk}/waitlists` });
  await expect(page.getByTestId("waitlist-decision").first()).toContainText(
    "Sibling already plays in the group",
  );
});

test("the club search lists the group as open for applications", async ({ page }) => {
  await loginAs(page, PERSONAS.henrik, { returnTo: `/clubs/find/${CLUBS.svk}` });
  await expect(page.getByTestId("open-group").first()).toContainText("full");
});
