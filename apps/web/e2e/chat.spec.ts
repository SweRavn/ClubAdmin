// SPDX-License-Identifier: AGPL-3.0-only
// The chat (P2.1) in SVK F2017's channel (P2.7b): the "Ej ansluten" banner
// shows only when the real-time connection is really down, and goes when it
// is back; the emoji panel inserts at the cursor.

import { expect, type Page, test } from "@playwright/test";

import { GROUPS, loginAs, PERSONAS } from "./personas.ts";

/** Opens F2017's default channel (created on first use). */
async function openChannel(page: Page) {
  await loginAs(page, PERSONAS.erik, { returnTo: `/groups/${GROUPS.svkF2017}` });
  await page.getByTestId("group-channels").getByTestId("chat-row").first().click();
  await expect(page.getByTestId("chat-room")).toBeVisible();
}

test("the offline banner shows only while the connection is down", async ({ page }) => {
  let blocked = false;
  const sockets: { close: () => Promise<void> }[] = [];
  const hosts = new Set<string>();
  await page.routeWebSocket(/\/api\/v1\/realtime/, (ws) => {
    hosts.add(new URL(ws.url()).host);
    if (blocked) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    sockets.push(ws);
  });
  await openChannel(page);
  // Connected: no banner, also after the grace period.
  await page.waitForTimeout(6_000);
  await expect(page.getByTestId("chat-offline")).toHaveCount(0);
  // On the page's own host (P2.7b): no second certificate or origin.
  expect([...hosts]).toEqual([new URL(page.url()).host]);

  // The connection drops and cannot come back: the banner appears.
  blocked = true;
  await Promise.all(sockets.map((s) => s.close()));
  await expect(page.getByTestId("chat-offline")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-offline")).toContainText("Ej ansluten");

  // Back: the next attempt connects and the banner goes.
  blocked = false;
  await expect(page.getByTestId("chat-offline")).toHaveCount(0, { timeout: 40_000 });
});

test("the emoji panel searches, inserts at the cursor and remembers recent emoji", async ({
  page,
}) => {
  await openChannel(page);
  const field = page.getByTestId("chat-input");
  await field.fill("Bra jobbat idag");
  // The cursor after "Bra jobbat".
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(10, 10));
  // Not loaded before the first open (ADR 0027).
  await expect(page.getByTestId("emoji-panel")).toHaveCount(0);
  await page.getByTestId("emoji-open").click();
  const search = page.getByTestId("emoji-search");
  await expect(search).toBeFocused();
  // Swedish search terms; the keyboard picks the first match.
  await search.fill("tummen upp");
  await expect(page.getByTestId("emoji-option").first()).toHaveText("👍");
  await search.press("ArrowDown");
  await expect(page.getByTestId("emoji-option").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("emoji-panel")).toHaveCount(0);
  await expect(field).toHaveValue("Bra jobbat👍 idag");
  await expect(field).toBeFocused();
  // Escape closes the panel and gives the focus back to the button.
  await page.getByTestId("emoji-open").click();
  await expect(page.getByRole("tab", { name: "Senast använda" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("emoji-option").first()).toHaveText("👍");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("emoji-panel")).toHaveCount(0);
  await expect(page.getByTestId("emoji-open")).toBeFocused();
});
