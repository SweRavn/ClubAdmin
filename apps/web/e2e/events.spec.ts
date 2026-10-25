// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up (P1.6) on the demo data: Sara sees Höstcupen with
// Alva's place and her sealed answer; Erik, the organiser, sees the list
// with the waiting list and creates an event with a question; Erik signs
// up Maja for IKN's party from "My schedule" and Samira sees Nadia's place; Gunilla (view_schedule only)
// sees the cup but cannot sign up.

import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("a guardian sees the child's place and the sealed answer; the organiser the list", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.sara, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page
    .getByTestId("group-events")
    .getByRole("link", { name: "Höstcupen i Strandviken" })
    .click();
  await expect(page.getByTestId("event-title")).toHaveText("Höstcupen i Strandviken");
  const mine = page.getByTestId("event-mine");
  await expect(mine).toContainText("Alva Ahmed");
  await expect(mine.getByTestId("registration-status").first()).toHaveText(/Plats bekräftad/);
  await expect(mine.getByText("Bara arrangörerna ser detta.").first()).toBeAttached();

  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page
    .getByTestId("group-events")
    .getByRole("link", { name: "Höstcupen i Strandviken" })
    .click();
  const table = page.getByTestId("registrations-table");
  await expect(table).toContainText("Nötter");
  await expect(table).toContainText("Nummer 1 på väntelistan");
  await expect(table).toContainText("Erbjudandet gick ut");
  await expect(page.getByTestId("event-export")).toBeVisible();
});

test("a relative with view_schedule only sees the event but no sign-up", async ({ page }) => {
  await loginAs(page, PERSONAS.gunilla, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page
    .getByTestId("group-events")
    .getByRole("link", { name: "Höstcupen i Strandviken" })
    .click();
  await expect(page.getByTestId("event-title")).toBeVisible();
  await expect(page.getByTestId("register-form")).toHaveCount(0);
});

test("an organiser creates an event; a parent signs up from My schedule", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, {
    returnTo: `/clubs/${CLUBS.svk}/events/new?groupId=${GROUPS.svkF2017}`,
  });
  const form = page.getByTestId("new-event-form");
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await form.getByTestId("event-title").fill("Läger i Bergby");
  await form.getByTestId("event-startDate").fill(inDays(30));
  await form.getByTestId("event-startTime").fill("09:00");
  await form.getByTestId("event-endDate").fill(inDays(31));
  await form.getByTestId("event-endTime").fill("15:00");
  await form.getByTestId("event-closesDate").fill(inDays(20));
  await form.getByTestId("event-closesTime").fill("20:00");
  await form.getByTestId("question-label").first().fill("Allergier");
  await form.getByTestId("question-sensitive").first().check();
  await form.getByTestId("event-publish").check();
  await page.getByTestId("event-create").click();
  await expect(page.getByTestId("event-title")).toHaveText("Läger i Bergby");
  await expect(page.getByTestId("notice")).toBeVisible();

  // Erik's daughter Maja plays in IKN: the club's party is open for her.
  await page.goto("/schedule");
  await page.getByTestId("schedule-events").getByRole("link", { name: "Avslutningsfest" }).click();
  const maja = page.getByTestId("event-mine").locator("div", { hasText: "Maja Johansson" }).last();
  await maja.getByTestId("register-submit").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(maja.getByTestId("registration-status")).toHaveText(/Plats bekräftad/);

  await loginAs(page, PERSONAS.samira, { returnTo: `/clubs/${CLUBS.ikn}/events` });
  await page.getByTestId("club-events").getByRole("link", { name: "Avslutningsfest" }).click();
  await expect(page.getByTestId("event-mine")).toContainText("Nadia Karimi");
  await expect(page.getByTestId("registration-status").first()).toHaveText(/Plats bekräftad/);
});
