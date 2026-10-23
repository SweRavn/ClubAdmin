// SPDX-License-Identifier: AGPL-3.0-only
// Activities and calendars (P1.4) on the demo scenario: Erik (head coach of
// SVK F2017, assistant coach of IKN F2015, Maja's father) sees one schedule
// across both clubs, adds a match and a series, cancels and restores, and
// changes "this and following"; Liam (a player in IKN P2012) sees his
// team's trainings but nothing to change; Anna (SVK club manager)
// uses the club calendar and adds a location.

import { expect, type Page, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

/** A date `days` from today (YYYY-MM-DD, UTC). */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

async function openFirst(page: Page, list: string, text: string | RegExp) {
  await page.getByTestId(list).getByRole("link", { name: text }).first().click();
  await page.waitForURL(/\/activities\//);
}

test("Erik's schedule covers his teams and Maja's in two clubs", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: "/schedule" });
  const schedule = page.getByTestId("schedule");
  await expect(schedule).toContainText("Träning");
  await expect(schedule).toContainText("Innebandyträning");
  // The cancelled session stays, marked, with its reason.
  const cancelled = schedule.locator('[data-testid="agenda-item"][data-status="cancelled"]');
  await expect(cancelled.first()).toContainText("Hallen är upptagen av kommunen");
  // Chips: everyone, Erik, Maja; Maja's own schedule has only her groups.
  const people = page.getByTestId("schedule-people");
  await people.getByRole("link", { name: /Maja/ }).click();
  await page.waitForURL(/person=/);
  await expect(page.getByTestId("schedule")).toContainText("Innebandyträning");
  // The home page shows what is coming.
  await page.goto("/");
  await expect(page.getByTestId("upcoming")).toBeVisible();
});

test("Liam sees his team's trainings but cannot change them", async ({ page }) => {
  await loginAs(page, PERSONAS.liam, { returnTo: "/schedule" });
  await openFirst(page, "schedule", "Fotbollsträning");
  await expect(page.getByTestId("activity-details")).toContainText("Norrbacka IP");
  await expect(page.getByTestId("activity-leaders")).toContainText("Ahmed");
  await expect(page.getByTestId("activity-leader-notes")).toHaveCount(0);
  await expect(page.getByTestId("activity-edit")).toHaveCount(0);
});

test("Erik adds a match, cancels and restores it", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page.getByTestId("new-activity").click();
  await page.waitForURL(/activities\/new/);
  await page.getByTestId("activity-kind").selectOption("match");
  await page.getByTestId("activity-title").fill("Träningsmatch mot Kustens VK");
  await page.getByTestId("activity-date").fill(day(9));
  await page.getByTestId("activity-startTime").fill("10:00");
  await page.getByTestId("activity-endTime").fill("11:30");
  await page.getByTestId("activity-opponent").fill("Kustens VK");
  await page.getByTestId("activity-leaderNotes").fill("Ta med matchtröjorna");
  await page.getByTestId("activity-create").click();
  await page.waitForURL(/\/activities\/.*saved=1/);
  await expect(page.getByTestId("activity-heading")).toContainText("Träningsmatch mot Kustens VK");
  await expect(page.getByTestId("activity-leader-notes")).toHaveText("Ta med matchtröjorna");

  await page.getByTestId("activity-cancel-reason").fill("Motståndarna har lämnat återbud");
  await page.getByTestId("activity-cancel").click();
  await page.waitForURL(/updated=1/);
  await expect(page.getByTestId("activity-cancelled")).toContainText("lämnat återbud");
  await page.getByTestId("activity-restore").click();
  await page.waitForURL(/updated=1/);
  await expect(page.getByTestId("activity-cancelled")).toHaveCount(0);
});

test("Erik previews and creates a series, then changes this and following", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/series/new` });
  const start = day(14);
  await page.getByTestId("series-title").fill("Fysträning");
  await page.getByTestId("series-weekday-0").selectOption(String(isoWeekday(start)));
  await page.getByTestId("series-start-0").fill("19:00");
  await page.getByTestId("series-startsOn").fill(start);
  await page.getByTestId("series-endsOn").fill(day(14 + 7 * 3));
  await page.getByTestId("series-preview-button").click();
  await page.waitForURL(/preview=1/);
  await expect(page.getByTestId("series-preview").locator("li")).toHaveCount(4);
  await page.getByTestId("series-create").click();
  await page.waitForURL(/\/activity-series\/.*saved=1/);
  await expect(page.getByTestId("series-sessions")).toHaveText("4");

  // The third session and the ones after it: a new series, later in the evening.
  const sessions = page.getByTestId("series-agenda").getByRole("link", { name: "Fysträning" });
  await expect(sessions).toHaveCount(4);
  await sessions.nth(2).click();
  await page.waitForURL(/\/activities\//);
  await page.getByTestId("activity-series-link").click();
  await page.waitForURL(/split=/);
  await page.getByTestId("series-title").fill("Fysträning (senare)");
  await page.getByTestId("series-start-0").fill("19:30");
  await page.getByTestId("series-split").click();
  await page.waitForURL(/\/activity-series\/.*saved=1/);
  await expect(page.getByTestId("series-title-heading")).toHaveText("Fysträning (senare)");
  await expect(page.getByTestId("series-sessions")).toHaveText("2");
});

test("Anna uses the club calendar and adds a location", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/calendar` });
  await expect(page.getByTestId("club-calendar")).toContainText("Träning herr (vinterschema)");
  await page.goto(`/clubs/${CLUBS.svk}/locations`);
  await expect(page.getByTestId("locations")).toContainText("Strandvikens sporthall");
  const name = `Strandvikens beachplaner ${Date.now() % 100_000}`;
  await page.getByTestId("location-name").last().fill(name);
  await page.getByTestId("location-city").last().fill("Strandviken");
  await page.getByTestId("location-create").click();
  await page.waitForURL(/added=1/);
  await expect(page.getByTestId("locations")).toContainText(name);
});
