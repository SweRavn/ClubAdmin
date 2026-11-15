// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents and meetings (P2.4) on the demo data in IK Norrbacka:
// Karin (the secretary) sees the adopted statutes; Peter (on the board)
// finds the board's minutes waiting for his signature in "Mina dokument",
// reads them (signing asks for a second factor), and marks his action item
// done in "Mina uppgifter" (and back, so the demo stays as seeded).

import { expect, test } from "@playwright/test";

import { loginAs, PERSONAS } from "./personas.ts";

const IKN = "0199a000-0000-7000-8001-000000000002";

test("the statutes are adopted; the minutes wait for the adjuster", async ({ page, context }) => {
  await loginAs(page, PERSONAS.karin, { returnTo: `/clubs/${IKN}/governing` });
  const statutes = page.getByTestId("series").filter({ hasText: "Stadgar" }).first();
  await expect(statutes).toContainText("Stadgar för IK Norrbacka");
  await expect(statutes).toContainText("Antagen");

  await context.clearCookies();
  await loginAs(page, PERSONAS.peter, { returnTo: "/me/documents" });
  const waiting = page.getByTestId("waiting-signatures");
  await expect(waiting).toContainText("Protokoll Styrelsemöte");
  await waiting.getByRole("link").first().click();
  await expect(page.getByTestId("draft-text")).toContainText("Ekonomi");
  await expect(page.getByTestId("signers").first()).toContainText("Väntar");
  // Signing needs a recent login with a second factor (not this one).
  await page.getByTestId("sign").getByRole("button").click();
  await expect(page.getByTestId("form-error")).toBeVisible();
});

test("an action item in Mina uppgifter is marked done", async ({ page }) => {
  await loginAs(page, PERSONAS.peter, { returnTo: "/me/tasks" });
  const task = page.getByTestId("task").filter({ hasText: "Skicka budgeten till revisorerna" });
  await expect(task).toContainText("Styrelsemöte");
  await task.getByTestId("task-toggle").click();
  await expect(page.getByTestId("tasks-empty")).toBeVisible();
  await page.goto("/me/tasks?status=closed");
  const done = page.getByTestId("task").filter({ hasText: "Skicka budgeten till revisorerna" });
  await done.getByTestId("task-toggle").click();
  await page.goto("/me/tasks");
  await expect(page.getByTestId("task")).toHaveCount(1);
});
