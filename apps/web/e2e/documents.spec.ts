// SPDX-License-Identifier: AGPL-3.0-only
// The file archive (P2.2) on the demo data: Erik (F2015's assistant coach in
// IK Norrbacka) finds the team's files in "Mina dokument", opens the match
// schedule's two versions, uploads a file to the team's folder (it waits for
// its virus scan) and sees the team's folders.
// Access rules, scanning and downloads are covered by the API and worker
// integration tests.

import { expect, test } from "@playwright/test";

import { loginAs, PERSONAS } from "./personas.ts";

test("Mina dokument, a file's versions, a notice's documents and an upload", async ({ page }) => {
  await loginAs(page, PERSONAS.erik, { returnTo: "/me/documents" });
  const mine = page.getByTestId("my-documents");
  await expect(mine).toContainText("Matchschema vår.pdf");
  await expect(mine).toContainText("Cupinfo Vårcupen.pdf");

  await mine.getByRole("link", { name: "Matchschema vår.pdf" }).click();
  await expect(page).toHaveURL(/\/clubs\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("versions").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("download-current")).toHaveAttribute(
    "href",
    /\/documents\/[0-9a-f-]{36}\/download$/,
  );
  await expect(page.getByTestId("audience")).toContainText("Visas för:");

  // The folder: Erik manages it and uploads a file.
  await page
    .getByRole("navigation", { name: "Sökväg" })
    .getByRole("link", { name: "Matchschema" })
    .click();
  await expect(page).toHaveURL(/\/clubs\/[0-9a-f-]{36}\/folders\/[0-9a-f-]{36}$/);
  const form = page.getByTestId("upload-form");
  await form.locator('input[type="file"]').setInputFiles({
    name: "Samåkning.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Samåkning till Vårcupen: vi ses vid klubbhuset 07.15.\n"),
  });
  await form.getByTestId("upload").click();
  await expect(page.getByTestId("notice")).toBeVisible();
  await expect(page.getByTestId("documents")).toContainText("Samåkning.txt");

  // The team's documents: its folders, opened from the folder's path.
  await page
    .getByRole("navigation", { name: "Sökväg" })
    .getByRole("link", { name: "Dokument", exact: true })
    .click();
  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]{36}\/documents$/);
  await expect(page.getByTestId("folders")).toContainText("Matchschema");
  await expect(page.getByTestId("folders")).toContainText("Kallelser");
});
