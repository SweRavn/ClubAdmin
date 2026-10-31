// SPDX-License-Identifier: AGPL-3.0-only
// Notifications (P1.7) on the demo data: Anna's bell shows her unread
// notices; opening the cancelled F2017 training marks it read and goes to
// the activity; she changes her settings; Liam reads his inbox in English;
// a broken unsubscribe link says so. The one-click unsubscribe from an
// email is covered by the API and worker integration tests.

import { expect, test } from "@playwright/test";

import { loginAs, PERSONAS } from "./personas.ts";

test("the bell counts unread notices; opening one marks it read and follows its link", async ({
  page,
}) => {
  await loginAs(page, PERSONAS.anna);
  const bell = page.getByTestId("notifications-bell");
  await expect(page.getByTestId("notifications-badge")).toHaveText("2");
  await bell.click();
  await expect(page).toHaveURL(/\/me\/notifications$/);
  const list = page.getByTestId("notifications");
  const cancelled = list.locator("li", { hasText: "Inställt:" }).first();
  await expect(cancelled).toHaveAttribute("data-unread", "true");
  await expect(cancelled).toContainText("Elsa Lindqvist");
  await cancelled.getByRole("button").click();
  await expect(page).toHaveURL(/\/activities\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("notifications-badge")).toHaveText("1");

  await page.goto("/me/notifications?unread=true");
  await expect(page.getByTestId("notifications").locator("li")).toHaveCount(1);
  await page.getByTestId("notifications-mark-all").click();
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
  await expect(page.getByTestId("notifications-badge")).toHaveCount(0);
});

test("settings per category are saved; mandatory emails say so", async ({ page }) => {
  await loginAs(page, PERSONAS.anna, { returnTo: "/me/notifications/settings" });
  const form = page.getByTestId("notification-settings");
  await expect(form.locator('tr[data-category="club_admin"]')).toContainText(
    "En del av dessa e-postmeddelanden skickas alltid.",
  );
  await page.getByTestId("email-events").selectOption("never");
  await page.getByTestId("save-notification-settings").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("email-events")).toHaveValue("never");
});

test("a reader in English, and a broken unsubscribe link", async ({ page }) => {
  await loginAs(page, PERSONAS.liam, { returnTo: "/me/notifications" });
  await expect(page.getByTestId("notifications")).toContainText("No longer called up");

  await page.goto("/unsubscribe?token=not-a-real-token-at-all-0000");
  await expect(page.getByTestId("unsubscribe-invalid")).toBeVisible();
});
