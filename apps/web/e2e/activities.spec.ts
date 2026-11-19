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

test("Erik sets the answer deadline as a date, never after the start (P2.7b)", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page.getByTestId("new-activity").click();
  await page.waitForURL(/activities\/new/);
  const fill = async (deadline: string) => {
    await page.getByTestId("activity-kind").selectOption("match");
    await page.getByTestId("activity-title").fill("Match mot Havsbyns VK");
    await page.getByTestId("activity-date").fill(day(11));
    await page.getByTestId("activity-startTime").fill("10:00");
    await page.getByTestId("activity-endTime").fill("11:30");
    await page.getByTestId("respond-by-date").fill(deadline);
    await page.getByTestId("respond-by-time").fill("18:00");
    await page.getByTestId("activity-create").click();
  };
  await fill(day(12));
  await expect(page.getByTestId("form-error")).toContainText("Svara senast");
  await fill(day(9));
  await page.waitForURL(/\/activities\/.*saved=1/);
  await expect(page.getByTestId("respond-by")).toContainText("18:00");
});

test("Erik previews and creates a series, then changes this and following", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/series/new` });
  const start = day(14);
  await page.getByTestId("series-title").fill("Fysträning");
  await page.getByTestId("series-weekday-0").selectOption(String(isoWeekday(start)));
  await page.getByTestId("series-start-0").fill("19:00");
  await page.getByTestId("series-startsOn").fill(start);
  await page.getByTestId("series-endsOn").fill(day(14 + 7 * 3));
  // Four sessions whatever today's date (a holiday such as Christmas Eve would be skipped).
  await page.getByTestId("series-skipHolidays").uncheck();
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

test("Erik makes a monthly series until further notice, removes a date and brings it back", async ({
  page,
}) => {
  // P1.14: the first Saturday of every month, the group asked two days before at 18:00.
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/series/new` });
  await page.getByTestId("series-title").fill("Lördagspass");
  await page.getByTestId("series-freq").selectOption("monthly");
  await page.getByTestId("series-ordinal-0").selectOption("1");
  await page.getByTestId("series-pos-weekday-0").selectOption("6");
  await page.getByTestId("series-rule-time").fill("10:00");
  await page.getByTestId("series-startsOn").fill(day(1));
  await page.getByTestId("series-ends-never").check();
  await page.getByTestId("request-days").check();
  await page.getByTestId("request-days-field").fill("2");
  await page.getByTestId("series-skipHolidays").uncheck();
  await page.getByTestId("series-preview-button").click();
  await page.waitForURL(/preview=1/);
  // Sessions 13 months ahead: 13 or 14 first Saturdays.
  const previewed = await page.getByTestId("series-preview").locator("li").count();
  expect(previewed).toBeGreaterThanOrEqual(13);
  expect(previewed).toBeLessThanOrEqual(14);
  await page.getByTestId("series-create").click();
  await page.waitForURL(/\/activity-series\/.*saved=1/);
  await expect(page.getByTestId("series-summary")).toHaveText(
    "Varje månad på första lördagen kl. 10:00, tills vidare",
  );
  await expect(page.getByTestId("series-request")).toContainText("2 dagar före kl. 18:00");

  // The next session's date, removed and brought back.
  const first = page
    .getByTestId("series-agenda")
    .getByRole("link", { name: "Lördagspass" })
    .first();
  await first.click();
  await page.waitForURL(/\/activities\//);
  await expect(page.getByTestId("activity-recurrence")).toContainText("första lördagen");
  await page.goBack();
  await page.getByTestId("series-remove-dates").click();
  const saturday = await page.evaluate(() => {
    const d = new Date();
    for (;;) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() === 6 && d.getUTCDate() <= 7) return d.toISOString().slice(0, 10);
    }
  });
  await page.getByTestId("series-remove-from").fill(saturday);
  await page.getByTestId("series-remove-dates-button").click();
  await page.waitForURL(/removed=1/);
  await expect(page.getByTestId("series-removed-dates")).toBeVisible();
  await page.getByTestId(`series-bring-back-${saturday}`).click();
  await page.waitForURL(/restored=1/);
  await expect(page.getByTestId("series-removed-dates")).toHaveCount(0);
});

// Anna, not Erik: Lighthouse measures Erik's home page after these tests, and an
// open application adds "In progress" to it.
test("Anna asks for a place in a group with direct admission (P1.14)", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/groups/${GROUPS.svkHerr}` });
  const apply = page.getByTestId("group-join-waitlist");
  await expect(apply).toHaveText("Ansök om plats");
  await apply.click();
  await page.waitForURL(/\/clubs\/find\//);
  await expect(page.getByTestId("open-group-state")).toHaveText(
    "Lediga platser: en ledare antar ansökan",
  );
  await page.getByTestId("apply-person").selectOption(PERSONAS.anna.id);
  await page.getByTestId(`apply-${GROUPS.svkHerr}`).click();
  await page.waitForURL(/\/me\/waitlists/);
  await expect(page.getByTestId("my-waitlist-entry").first()).toContainText("Herr senior");
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

test("Erik, F2017's head coach, answers that he is coming to the next training (P2.7b)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.erik, { returnTo: "/schedule" });
  // The answer is saved in place (ADR 0055): the page is not reloaded.
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });
  const mine = page.getByTestId(`response-${PERSONAS.erik.id}`).first();
  await mine.getByTestId("response-attending").click();
  await expect(
    page.getByTestId(`response-${PERSONAS.erik.id}`).first().getByTestId("response-attending"),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );
});

test("Anna answers for Elsa with one tap on the activity page; the note is saved on its own (P2.7b)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/schedule" });
  const item = page
    .getByTestId("agenda-item")
    .filter({ has: page.getByTestId(`response-${PERSONAS.elsa.id}`) })
    .first();
  await item.getByRole("link").first().click();
  await page.waitForURL(/\/activities\//);
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });
  const form = page.getByTestId(`response-${PERSONAS.elsa.id}`);
  await form.getByTestId("response-note").fill("Kommer tio minuter sent");
  await form.getByTestId("response-attending").click();
  await expect(form.getByTestId("response-attending")).toHaveAttribute("aria-pressed", "true");
  await expect(form.getByTestId("response-note")).toHaveValue("Kommer tio minuter sent");
  await form.getByTestId("response-note").fill("Kommer en kvart sent");
  await form.getByTestId("response-save").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(form.getByTestId("response-note")).toHaveValue("Kommer en kvart sent");
  // Saved: the same note after a fresh load.
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );
  await page.reload();
  await expect(form.getByTestId("response-note")).toHaveValue("Kommer en kvart sent");
});

test("Anna arranges a car pool for Oskar's next training with one tap (P2.7b)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/groups/${GROUPS.iknP2012}` });
  await page
    .getByTestId("group-calendar")
    .getByTestId("agenda-item")
    .filter({ hasText: "Träning" })
    .first()
    .getByRole("link")
    .first()
    .click();
  await page.waitForURL(/\/activities\//);
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });
  // No transport mode set: "Ordna samåkning" opens the offer form.
  await expect(page.getByTestId("carpool-offer")).toHaveText("Ordna samåkning");
  await page.getByTestId("carpool-offer").click();
  await page.getByTestId("carpool-offer-submit").click();
  await expect(page.getByTestId("carpool-car").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );
});

test("breadcrumbs on a group's consents and attendance pages (P2.7b)", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}/consents` });
  const trail = page.getByTestId("breadcrumbs");
  await expect(trail.getByRole("link", { name: "Strandvikens Volleybollklubb" })).toBeVisible();
  await expect(trail.getByRole("link", { name: "F2017" })).toBeVisible();
  await expect(trail.locator('[aria-current="page"]')).toHaveText("Samtycken");
  await page.goto(`/groups/${GROUPS.svkF2017}/attendance`);
  await expect(page.getByTestId("breadcrumbs").locator('[aria-current="page"]')).toBeVisible();
  await page.getByTestId("breadcrumbs").getByRole("link", { name: "F2017" }).click();
  await page.waitForURL(new RegExp(`/groups/${GROUPS.svkF2017}$`));
});
