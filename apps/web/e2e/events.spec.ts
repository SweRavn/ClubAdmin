// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up (P1.6) on the demo data: Sara sees Höstcupen with
// Alva's place and her sealed answer; Erik, the organiser, sees the list
// with the waiting list and creates an event with a question; Erik signs
// up Maja for IKN's party from "My schedule" and Samira sees Nadia's place; Johan,
// an assistant coach, sees the list but has nobody to sign up.

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

// Gunilla's link to Alva is ended by families.spec.ts, which runs first; the
// relative without sign_up is covered in events.integration.test.ts (403).
test("an assistant coach sees the event and the registrations but no sign-up", async ({ page }) => {
  await loginAs(page, PERSONAS.johan, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page
    .getByTestId("group-events")
    .getByRole("link", { name: "Höstcupen i Strandviken" })
    .click();
  await expect(page.getByTestId("event-title")).toBeVisible();
  await expect(page.getByTestId("registrations-table")).toBeVisible();
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
  await page.goto("/");
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

test("Anna creates a club event with only an end time and a second question, without console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/events/new` });
  const form = page.getByTestId("new-event-form");
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await form.getByTestId("event-audience-club").check();
  await form.getByTestId("event-title").fill("Spela volleyboll");
  await form.getByTestId("event-startDate").fill(inDays(8));
  await form.getByTestId("event-startTime").fill("08:00");
  // Only an end time (P2.7b): the event ends the day it starts.
  await form.getByTestId("event-endTime").fill("10:50");
  await form.getByTestId("question-label").first().fill("Tröjstorlek");
  await form.getByTestId("questions-add").click();
  await form.getByTestId("question-label").nth(1).fill("Allergier");
  await page.getByTestId("event-create").click();
  await expect(page.getByTestId("event-title")).toHaveText("Spela volleyboll");
  expect(errors.filter((e) => e.includes("key"))).toEqual([]);
});

test("Anna leaves a half-filled new event, is asked, and later continues the draft (P2.7b)", async ({
  page,
}) => {
  // Reloading with changes gets the browser's own question, which is accepted.
  const prompts: string[] = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.type());
    void dialog.accept();
  });
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/events/new` });
  const form = page.getByTestId("new-event-form");
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
  await form.getByTestId("event-audience-club").check();
  await form.getByTestId("event-title").fill("Höstfest");
  // Another menu item: the app asks first.
  await page.getByTestId("nav-groups").click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await expect(page.getByTestId("unsaved-dialog")).toContainText("inte sparats");
  // Stays: still on the form with what was typed.
  await page.getByTestId("unsaved-stay").click();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  await expect(form.getByTestId("event-title")).toHaveValue("Höstfest");
  await expect(page).toHaveURL(/\/events\/new/);
  // Leaves.
  await page.getByTestId("nav-groups").click();
  await page.getByTestId("unsaved-leave").click();
  await expect(page).toHaveURL(/\/groups$|\/clubs\/[^/]+\/groups/);
  // Comes back: "Fortsätt på utkastet" fills the form again.
  await page.goto(`/clubs/${CLUBS.svk}/events/new`);
  await expect(page.getByTestId("draft-banner")).toBeVisible();
  await page.getByTestId("draft-resume").click();
  await expect(form.getByTestId("event-title")).toHaveValue("Höstfest");
  await expect(form.getByTestId("event-audience-club")).toBeChecked();
  // Reloading with the resumed changes asks (the browser's prompt).
  await page.reload();
  expect(prompts).toContain("beforeunload");
  // Started over: the draft is gone.
  await page.getByTestId("draft-discard").click();
  await page.reload();
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
});

test("a new event that ends before it starts says so next to the end, keeping what was typed (P2.7c)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/events/new` });
  const form = page.getByTestId("new-event-form");
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await form.getByTestId("event-audience-club").check();
  await form.getByTestId("event-title").fill("Vårfest");
  await form.getByTestId("event-startDate").fill(inDays(9));
  await form.getByTestId("event-startTime").fill("18:00");
  await form.getByTestId("event-endTime").fill("17:00");
  await page.getByTestId("event-create").click();
  // The summary at the top, and the message next to the end time, which has focus.
  await expect(page.getByTestId("form-error")).toBeVisible();
  const error = form.locator('[data-testid="field-error"][data-field="endTime"]');
  await expect(error).toContainText("Slutet måste vara efter starten");
  await expect(form.getByTestId("event-endTime")).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByTestId("event-endTime")).toBeFocused();
  await expect(form.getByTestId("event-title")).toHaveValue("Vårfest");
  // Fixed: the event is created.
  await form.getByTestId("event-endTime").fill("21:00");
  await page.getByTestId("event-create").click();
  await expect(page.getByTestId("event-title")).toHaveText("Vårfest");
});
