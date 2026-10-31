// SPDX-License-Identifier: AGPL-3.0-only
// The clean-up after hands-on testing (P1.6b) on the demo data: an event
// with only a name and a start date, the period checked in the browser;
// groups created, changed and deleted; places a leader added; a leader
// answering for a player; Henrik seeing Viktor's place in the queue; the
// club's contact details; joining with a code. Runs last: it changes data.

import { expect, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

test("an event needs only a name and a start date; an end before the start is caught at once", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.erik, {
    returnTo: `/clubs/${CLUBS.svk}/events/new?groupId=${GROUPS.svkF2017}`,
  });
  const form = page.getByTestId("new-event-form");
  await expect(form.getByTestId("event-publish")).toBeChecked();
  await form.getByTestId("event-title").fill("Lagfest");
  await form.getByTestId("event-startDate").fill("2031-06-14");
  await form.getByTestId("event-endDate").fill("2031-06-13");
  await expect(page.getByTestId("event-period-error")).toBeVisible();
  await expect(form.getByTestId("event-create")).toBeDisabled();
  await form.getByTestId("event-endDate").fill("");
  await expect(page.getByTestId("event-period-error")).toBeHidden();
  // Sessions and questions are added in the browser.
  await form.getByTestId("sessions-add").click();
  await expect(form.getByTestId("sessions-row").nth(1)).toBeVisible();
  await form.getByTestId("event-create").click();
  await page.waitForURL(/\/events\/[0-9a-f-]+\?saved=1/);
  await expect(page.getByTestId("event-title")).toHaveText("Lagfest");
});

test("Anna creates a group, changes it and deletes it while unused", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/groups` });
  await page.getByTestId("groups-new").click();
  await page.getByTestId("group-name").fill("Felskapad grupp");
  await page.getByTestId("group-create").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await page.getByTestId("group-edit").click();
  await page.getByTestId("group-name").fill("Felskapad grupp 2");
  await page.getByTestId("group-save").click();
  await expect(page.getByTestId("group-name")).toContainText("Felskapad grupp 2");
  await page.getByTestId("group-edit").click();
  await page.getByTestId("group-delete-confirm").check();
  await page.getByTestId("group-delete").click();
  await page.waitForURL((url) => url.pathname === `/clubs/${CLUBS.svk}/groups`);
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("groups-tree")).not.toContainText("Felskapad grupp");
});

test("Erik changes the place he added but not the club's", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/clubs/${CLUBS.svk}/locations` });
  const own = page.getByTestId("location").filter({ hasText: "Strandviksskolans gymnastiksal" });
  await expect(own.getByTestId("location-edit")).toBeVisible();
  const clubs = page.getByTestId("location").filter({ hasText: "Strandvikens sporthall" });
  await expect(clubs.getByTestId("location-edit")).toHaveCount(0);
});

test("Erik answers for a player from the leaders' list", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page
    .getByTestId("agenda-item")
    .filter({ hasNotText: "Inställd" })
    .getByRole("link", { name: "Träning", exact: true })
    .first()
    .click();
  const list = page.getByTestId("response-list");
  await expect(list).toBeVisible();
  const row = list.locator("li").first();
  await row.getByTestId("leader-response-not-attending").click();
  await expect(page.getByTestId("response-list").locator("li").first()).toContainText(
    /Kommer inte/,
  );
});

test("Henrik sees Viktor's place on the waiting list", async ({ page }) => {
  await loginAs(page, PERSONAS.henrik);
  await expect(page.getByTestId("waitlist-entry")).toContainText(
    /Viktor Malm.*F2017.*plats \d+ av \d+/,
  );
});

test("members see the club's contact details", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: `/clubs/${CLUBS.svk}` });
  await expect(page.getByTestId("club-phone")).toHaveCount(2);
  await expect(page.getByText("kansli@strandvikens-vk.test")).toBeVisible();
});

test("a code from a club leads to the club without an account", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const page = await context.newPage();
  await page.goto("/join");
  await page.getByTestId("join-code").fill("knb7dema");
  await page.getByTestId("join-code-submit").click();
  await expect(page.getByTestId("invitation-club")).toContainText("IK Norrbacka");
  await expect(page.getByTestId("login-to-accept")).toBeVisible();
  await context.close();
});
