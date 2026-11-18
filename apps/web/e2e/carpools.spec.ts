// SPDX-License-Identifier: AGPL-3.0-only
// Car pools and mileage claims (P2.5, ADR 0048) on the demo data in IK
// Norrbacka P2012: Anna drives to Saturday's away match with a note for her
// passengers and one player has no ride (the leaders see who); Ahmed confirms that Liam may ride
// home alone with Anna; the attesters' queue and "Mina
// utlägg" show Anna's approved and rejected claims; the group's statistics
// count her drives.

import { expect, test } from "@playwright/test";

import { GROUPS, loginAs, PERSONAS } from "./personas.ts";

const IKN = "0199a000-0000-7000-8001-000000000002";
const AWAY_MATCH = "0199a000-0000-7000-8015-000000000010";

test("the away match shows the cars, the note and who has no ride", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/activities/${AWAY_MATCH}` });
  const section = page.getByTestId("carpool");
  const mine = section.getByTestId("carpool-car").filter({ hasText: "Din bil" }).first();
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId("carpool-note")).toContainText("bollbag");
  await expect(mine.getByTestId("carpool-bookings")).toContainText("Oskar");
  // Who has no ride is for the leaders.
  await expect(section.getByTestId("carpool-without-ride")).toHaveCount(0);

  await page.goto("/me/carpools");
  await expect(page.getByTestId("my-carpool").first()).toContainText("Du kör");
});

test("a guardian confirms that the child rides home alone with the driver", async ({ page }) => {
  await loginAs(page, PERSONAS.ahmed, { returnTo: `/activities/${AWAY_MATCH}` });
  const withoutRide = page.getByTestId("carpool-without-ride");
  await expect(withoutRide).toContainText("Saknar skjuts");
  await expect(withoutRide).not.toContainText("Alla har skjuts");

  await page.goto("/me/carpools");
  const waiting = page
    .getByTestId("my-carpool")
    .filter({ hasText: "Liam" })
    .filter({
      has: page.getByTestId("my-carpool-confirm"),
    });
  await expect(waiting).toContainText("Anna");
  await waiting.getByTestId("my-carpool-confirm").click();
  await expect(page.getByTestId("notice")).toContainText("Godkänt");
  await expect(page.getByTestId("my-carpool-confirm")).toHaveCount(0);

  // From which age the children book seats themselves (empty: the country's 13).
  await page.goto("/me/family");
  await expect(page.getByTestId("carpool-age").first()).toHaveAttribute("placeholder", "13");
});

test("claims: approved and rejected for Anna, in the queue for Ahmed", async ({
  page,
  context,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/expenses" });
  const claims = page.getByTestId("my-claim");
  await expect(claims).toHaveCount(2);
  await expect(claims.filter({ hasText: "Attesterat" })).toHaveCount(1);
  await expect(claims.filter({ hasText: "Avslaget" })).toContainText("buss");

  await context.clearCookies();
  await loginAs(page, PERSONAS.ahmed, { returnTo: `/clubs/${IKN}/expenses?status=approved` });
  await expect(page.getByTestId("queue-claim").first()).toContainText("Anna");
  await page.goto(`/clubs/${IKN}/expenses`);
  await expect(page.getByTestId("queue-empty")).toBeVisible();

  await page.goto(`/groups/${GROUPS.iknP2012}/carpools`);
  await expect(page.getByTestId("carpool-stats")).toContainText("Anna");
});
