// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8) on the demo data: Anna (SVK's registrar) ticks
// off Johan's extract with a second factor, nothing uploaded; Göran (IKN
// P2012's new assistant coach, no check) is refused when he writes to Liam
// (a child) and is not offered the "Sekretariat" shift, with the reason;
// Tilde sees in "Mitt konto" when her extract needs renewing.
import { expect, test } from "@playwright/test";

import { CLUBS, loginAs, PERSONAS } from "./personas.ts";

const HOME_MATCH = "0199a000-0000-7000-8015-000000000020";
const today = new Date().toISOString().slice(0, 10);

test("the registrar ticks off a shown extract (second factor, nothing kept)", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, {
    returnTo: `/clubs/${CLUBS.svk}/safeguarding/background-checks`,
    mfa: true,
  });
  const johan = page.getByTestId(`background-check-${PERSONAS.johan.id}`);
  await expect(johan).toContainText("Giltigt");
  const form = page.getByTestId("background-check-record");
  await form.getByTestId("record-person").selectOption(PERSONAS.johan.id);
  await form.getByTestId("record-issued").fill(today);
  await expect(form.locator('input[type="file"]')).toHaveCount(0);
  await form.getByTestId("record-submit").click();
  await expect(page.getByTestId("notice")).toHaveText("Utdraget är avbockat.");
  await expect(page.getByTestId(`background-check-${PERSONAS.johan.id}`)).toContainText(
    "visat på papper",
  );
});

test("a leader without a check is refused in a child's chat and on a Sekretariat shift", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.goran, {
    returnTo: `/people/${PERSONAS.liam.id}?clubId=${CLUBS.ikn}`,
  });
  await page.getByTestId("send-message").getByRole("button").click();
  await expect(page.getByTestId("form-error")).toContainText("utdrag ur belastningsregistret");

  await page.goto(`/activities/${HOME_MATCH}`);
  const duties = page.getByTestId("activity-duties");
  await expect(duties).toContainText("Sekretariat – hemmamatch");
  await expect(duties.getByTestId("duty-needs-check")).toContainText(
    "utdrag ur belastningsregistret",
  );
});

test("Mitt konto shows when the extract needs renewing", async ({ page }) => {
  await loginAs(page, PERSONAS.tilde, { returnTo: "/me/background-checks" });
  const ikn = page.getByTestId(`my-checks-${CLUBS.ikn}`);
  await expect(ikn.getByTestId("my-check-status")).toContainText("Ditt utdrag gäller till");
  await expect(ikn).toContainText("Beställ ett nytt i god tid");
});
