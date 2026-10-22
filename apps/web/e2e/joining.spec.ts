// SPDX-License-Identifier: AGPL-3.0-only
// Sign-up to membership in the browser (P1.1): Emma finds Strandvikens VK and asks
// to join, Anna (club manager) approves; an invitation link from Anna takes
// Liam into the club; Anna proposes a manager hand-over that Erik declines.
// Runs after the other DEV_AUTH specs: it changes the demo data.

import { type Browser, expect, type Page, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

async function as(
  browser: Browser,
  persona: { id: string; name: string },
  options: { returnTo?: string; mfa?: boolean } = {},
): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const page = await context.newPage();
  await loginAs(page, persona, options);
  return page;
}

test("Emma asks to join Strandvikens VK and Anna approves", async ({ browser }) => {
  const emma = await as(browser, PERSONAS.emma);
  await emma.getByTestId("find-club").click();
  await emma.getByTestId("club-search").fill("Strandvikens");
  await emma.getByRole("button", { name: "Sök" }).click();
  const results = emma.getByTestId("club-results");
  await expect(results).toContainText("Strandvikens");
  await results.getByText("Ansök om medlemskap").first().click();
  await emma.getByTestId(`ask-${CLUBS.svk}`).click();
  await expect(emma.getByTestId("notice")).toContainText("Din ansökan är skickad");
  await expect(emma.getByTestId("in-progress")).toContainText("Strandvikens");

  const anna = await as(browser, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}` });
  await anna.getByTestId("nav-join-requests").click();
  await anna.getByTestId(`approve-${PERSONAS.emma.id}`).click();
  await expect(anna.getByTestId("notice")).toBeVisible();

  await emma.goto("/");
  await expect(emma.getByTestId("my-clubs")).toContainText("Strandvikens");
  await emma.context().close();
  await anna.context().close();
});

test("an invitation link takes Liam into the club", async ({ browser }) => {
  const anna = await as(browser, PERSONAS.anna, { returnTo: `/clubs/${CLUBS.svk}/invitations` });
  await anna.getByTestId("create-invitation").click();
  const link = (await anna.getByTestId("invitation-value").textContent())?.trim() ?? "";
  expect(link).toMatch(/\/join\//);
  await anna.context().close();

  // Not logged in: the landing page names the club and asks to log in.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "sv-SE" });
  const page = await context.newPage();
  const path = new URL(link).pathname;
  await page.goto(path);
  await expect(page.getByTestId("invitation-club")).toContainText("Strandvikens");
  await expect(page.getByTestId("login-to-accept")).toBeVisible();
  await page.getByTestId("login-to-accept").click();
  await page
    .getByRole("button", { name: /^(Logga in som|Log in as|Logg inn som) Liam Yilmaz$/ })
    .first()
    .click();
  await page.getByTestId("accept-invitation").click();
  await page.waitForURL((url) => url.pathname === `/clubs/${CLUBS.svk}`);
  await expect(page.getByTestId("notice")).toBeVisible();
  await context.close();
});

test("Anna proposes a hand-over; Erik sees it and declines", async ({ browser }) => {
  const anna = await as(browser, PERSONAS.anna, {
    returnTo: `/people/${PERSONAS.erik.id}?clubId=${CLUBS.svk}`,
    mfa: true,
  });
  await anna.getByTestId("propose-handover").click();
  await anna.waitForURL((url) => url.pathname === `/clubs/${CLUBS.svk}/managers`);
  await expect(anna.getByTestId("outgoing-handover")).toContainText("Erik Johansson");

  const erik = await as(browser, PERSONAS.erik);
  const handover = erik.getByTestId("handover");
  await expect(handover).toContainText("Anna Lindqvist");
  await handover.getByRole("button", { name: "Tacka nej" }).click();
  await expect(erik.getByTestId("handover")).toHaveCount(0);

  await anna.reload();
  await expect(anna.getByTestId("outgoing-handover")).toHaveCount(0);
  await erik.context().close();
  await anna.context().close();
});
