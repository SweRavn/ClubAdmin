// SPDX-License-Identifier: AGPL-3.0-only
// "Min profil" (P2.7d, ADR 0057): Anna changes her phone, then her login
// email with the code sent to the new address (Mailpit); the old address is
// told. She changes it back at the end, for the tests that come after.

import { expect, type Page, test } from "@playwright/test";

import { MAILPIT_URL, uniqueEmail, waitForMail } from "./helpers.ts";
import { loginAs, PERSONAS } from "./personas.ts";

const ANNA_EMAIL = "anna.lindqvist@example.test";

/** How many emails to `to` with this subject Mailpit has. */
async function count(to: string, subject: string): Promise<number> {
  const query = encodeURIComponent(`to:${to} subject:"${subject}"`);
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
  return ((await res.json()) as { messages_count?: number }).messages_count ?? 0;
}

async function changeEmail(page: Page, to: string) {
  await page.getByTestId("new-email").fill(to);
  await page.getByTestId("email-request").click();
  await expect(page.getByTestId("pending-email")).toContainText(to);
  // The current address still logs in until the code is entered.
  const mail = await waitForMail(to);
  const code = /\b(\d{6})\b/.exec(mail)?.[1];
  expect(code).toBeTruthy();
  await page.getByTestId("email-code").fill(code!);
  await page.getByTestId("email-confirm").click();
  await expect(page.getByTestId("current-email")).toHaveText(to);
  await expect(page.getByTestId("pending-email")).toHaveCount(0);
}

test.setTimeout(180_000);

test("Anna changes her phone and her login email, confirmed through Mailpit (P2.7d)", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me" });
  await page.getByTestId("me-profile").click();
  await page.waitForURL(/\/me\/profile/);
  await page.evaluate(() => {
    (window as unknown as { noReload: boolean }).noReload = true;
  });

  await page.getByTestId("contact-phone").fill("+46 70 174 06 99");
  await page.getByTestId("contact-save").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("contact-phone")).toHaveValue("+46 70 174 06 99");

  await expect(page.getByTestId("current-email")).toHaveText(ANNA_EMAIL);
  // The notice is in the account's language (none set for Anna: English).
  const notices = async () =>
    (await count(ANNA_EMAIL, "Din e-postadress har ändrats")) +
    (await count(ANNA_EMAIL, "Your email address changed"));
  const before = await notices();
  const next = uniqueEmail("anna-ny");
  await changeEmail(page, next);

  // The old address is told.
  await expect.poll(notices, { timeout: 90_000 }).toBe(before + 1);

  // Back to the demo address for the tests that follow.
  await changeEmail(page, ANNA_EMAIL);
  await page.getByTestId("contact-phone").fill("+46 70 174 06 05");
  await page.getByTestId("contact-save").click();
  await expect(page.getByTestId("contact-phone")).toHaveValue("+46 70 174 06 05");
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(
    true,
  );

  // A guardian changes the child's phone on the child's profile.
  await page.goto(`/people/${PERSONAS.elsa.id}`);
  await page.getByTestId("edit-contact").locator("summary").click();
  await page.getByTestId("contact-phone").fill("+46 70 174 06 98");
  await page.getByTestId("contact-save").click();
  await expect(page.getByTestId("person-profile").locator('[data-field="phone"]')).toContainText(
    "+46 70 174 06 98",
  );
});
