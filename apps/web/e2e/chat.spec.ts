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
  // The field is the chat's own (React) state: type only once the page runs.
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("emoji-open")).toBeEnabled();
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
  // The technical reason, so a person without developer tools can report it.
  await expect(page.getByTestId("chat-offline-reason")).toContainText("Teknisk orsak:");

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

test("the chat keeps its size: messages scroll inside, the field stays in view (P2.7c)", async ({
  page,
}) => {
  await openChannel(page);
  const field = page.getByTestId("chat-input");
  for (let i = 1; i <= 25; i++) {
    await field.fill(`Meddelande ${i}`);
    await field.press("Enter");
    await expect(page.getByTestId("chat-body").filter({ hasText: `Meddelande ${i}` })).toHaveCount(
      1,
    );
  }
  await expect(field).toBeInViewport();
  await expect(page.getByTestId("chat-body").last()).toBeInViewport();
  const scroll = page.getByTestId("chat-scroll");
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The page itself does not grow with the messages.
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 400),
  ).toBe(true);
});
