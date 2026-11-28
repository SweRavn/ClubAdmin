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

  // Among the demo's other rides (P2.7d), her own car.
  await page.goto("/me/carpools");
  await expect(page.getByTestId("my-carpool").filter({ hasText: "Du kör" }).first()).toBeVisible();
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

// P2.7c: SVK F2017's away match has Mikael's car (there and home) and
// Johan's (there only).
const SVK_MATCH = "0199a000-0000-7000-8015-000000000013";

test("Sara books Alva's seat there and home in one choice from the schedule (P2.7d)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.sara, { returnTo: "/?weeks=4" });
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });
  const match = page
    .getByTestId("agenda-item")
    .filter({ has: page.locator(`a[href="/activities/${SVK_MATCH}"]`) });
  const answer = match.getByTestId(`response-${PERSONAS.alva.id}`);
  const alva = match.getByTestId(`rides-${PERSONAS.alva.id}`);
  // Alva has not answered: one menu, "Kommer ▾", with the cars and whether
  // they drive home; a car answers "Kommer" and books there and home.
  await answer.getByTestId("response-attending").click();
  await answer
    .getByTestId("response-ride")
    .filter({ hasText: /Mikael Lindqvist · Strandviksskolan.*dit och hem/ })
    .click();
  await expect(alva.getByTestId("ride-booked-out")).toContainText("Mikael Lindqvist");
  await expect(alva.getByTestId("ride-booked-back")).toContainText("Bergby sporthall");
  // No second place to book: no "Åk med" under the answer once she has a seat.
  await expect(alva.getByTestId("ride-menu")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );
  // Cancelling the way home keeps the seat there.
  await alva.getByTestId("ride-cancel-back").click();
  await expect(alva.getByTestId("ride-booked-back")).toHaveCount(0);
  await expect(alva.getByTestId("ride-booked-out")).toBeVisible();
});

test("Erik answers Kommer with a seat in Johan's car from the group's list (P2.7c)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  const match = page
    .getByTestId("agenda-item")
    .filter({ has: page.locator(`a[href="/activities/${SVK_MATCH}"]`) });
  const answer = match.getByTestId(`response-${PERSONAS.erik.id}`);
  await answer.getByTestId("response-attending").click();
  // "Tar mig dit själv" or a car: the driver and where they leave from.
  await expect(answer.getByTestId("response-self")).toBeVisible();
  // Johan drives there only: the menu says so.
  await answer
    .getByTestId("response-ride")
    .filter({ hasText: /Johan.*bara dit/ })
    .click();
  const rides = match.getByTestId(`rides-${PERSONAS.erik.id}`);
  await expect(rides.getByTestId("ride-booked-out")).toContainText("Johan");
  // The answer is given: the activity page shows "Kommer" chosen and the seat.
  await page.goto(`/activities/${SVK_MATCH}`);
  await expect(page.getByTestId("carpool")).toContainText("Erik Johansson");
});

test("the last free seat in Erik's car is offered for Alva (P2.7d)", async ({ page }) => {
  // The demo's next F2017 training: Erik's car has three seats, Maja and Johan two.
  await loginAs(page, PERSONAS.sara, { returnTo: "/?weeks=4" });
  const rides = page
    .getByTestId(`rides-${PERSONAS.alva.id}`)
    .filter({ has: page.getByTestId("ride-menu") });
  const withErik = rides.filter({
    has: page.getByTestId("ride-book").filter({ hasText: "Erik Johansson" }),
  });
  await expect(withErik.first()).toBeAttached();
  await withErik.first().getByTestId("ride-menu").locator("summary").click();
  await expect(
    withErik
      .first()
      .getByTestId("ride-book")
      .filter({ hasText: /Erik Johansson.*dit och hem/ }),
  ).toBeVisible();
});

test("Erik offers his car with one tap from the group's list, with his defaults (P2.7f)", async ({
  page,
}) => {
  // Erik keeps defaults (the demo): 3 seats, a note, home 20 minutes after the end.
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });
  const item = page
    .getByTestId("agenda-item")
    .filter({ has: page.getByTestId("carpool-quick") })
    .first();
  const href = await item.getByRole("link").first().getAttribute("href");
  await item.getByTestId("carpool-quick").click();
  await expect(
    page
      .getByTestId("agenda-item")
      .filter({ has: page.locator(`a[href="${href}"]`) })
      .getByTestId("carpool-quick"),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );
  await page.goto(href!);
  const mine = page.getByTestId("carpool-car").filter({ hasText: "Din bil" });
  await expect(mine.first()).toContainText("Plats för en bollbag");
});

test("Mikael offers his car with one tap from Mitt schema on Home (P2.7f)", async ({ page }) => {
  // Mikael keeps defaults (the demo) and nobody drives to the friendly match yet.
  await loginAs(page, PERSONAS.mikael, { returnTo: "/?weeks=4" });
  const item = page
    .getByTestId("agenda-item")
    .filter({ hasText: "Träningsmatch mot Norrby VK" })
    .first();
  await item.getByTestId("carpool-quick").click();
  await expect(
    page
      .getByTestId("agenda-item")
      .filter({ hasText: "Träningsmatch mot Norrby VK" })
      .getByTestId("carpool-quick"),
  ).toHaveCount(0);
  await page.goto("/activities/0199a000-0000-7000-8015-000000000015");
  await expect(
    page.getByTestId("carpool-car").filter({ hasText: "Din bil" }).first(),
  ).toBeVisible();
});

test("Anna keeps her car-pool defaults on her profile (P2.7f)", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/profile" });
  const form = page.getByTestId("carpool-defaults-form");
  await form.getByTestId("carpool-defaults-seats").fill("4");
  await form.getByTestId("carpool-defaults-place").fill("Strandvägen 12");
  await form.getByTestId("carpool-defaults-note").fill("Barnstol finns");
  await form.getByTestId("carpool-defaults-returnMinutes").fill("10");
  await form.getByTestId("carpool-defaults-save").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(form.getByTestId("carpool-defaults-seats")).toHaveValue("4");
  await expect(form.getByTestId("carpool-defaults-returnMinutes")).toHaveValue("10");
  // Back to none, for the tests that come after.
  await form.getByTestId("carpool-defaults-clear").click();
  await expect(page.getByTestId("carpool-defaults-clear")).toHaveCount(0);
});
