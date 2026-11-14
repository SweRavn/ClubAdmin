// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end tests against the running stack (pnpm dev:services, the API and
// the web app): real login through Zitadel and DEV_AUTH. Run with
// `pnpm --filter @clubadmin/web test:e2e`; BASE_URL defaults to the local site.

import { defineConfig, devices } from "@playwright/test";

const chromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.BASE_URL ?? "https://clubadmin.localhost",
    // Caddy's local development CA.
    ignoreHTTPSErrors: true,
    locale: "sv-SE",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
  },
  // E2E_PRODUCTION=1: only the checks against the production build (`next
  // build && next start`, no DEV_AUTH); otherwise the suite against `next dev`.
  projects: process.env.E2E_PRODUCTION
    ? [{ name: "production", testMatch: /production\.spec\.ts/ }]
    : [
        // Signs up through Zitadel first.
        { name: "zitadel", testMatch: /zitadel\.spec\.ts/ },
        {
          name: "dev-auth",
          testMatch: /(dev-auth|app-shell)\.spec\.ts/,
          dependencies: ["zitadel"],
        },
        // Reads the seeded inboxes before other specs create notices (P1.7).
        {
          name: "notifications",
          testMatch: /notifications\.spec\.ts/,
          dependencies: ["dev-auth"],
        },
        // Changes the demo data: after the specs that read it.
        { name: "joining", testMatch: /joining\.spec\.ts/, dependencies: ["notifications"] },
        { name: "members", testMatch: /members\.spec\.ts/, dependencies: ["joining"] },
        { name: "families", testMatch: /families\.spec\.ts/, dependencies: ["members"] },
        {
          name: "member-imports",
          testMatch: /member-imports\.spec\.ts/,
          dependencies: ["families"],
        },
        {
          name: "activities",
          testMatch: /activities\.spec\.ts/,
          dependencies: ["member-imports"],
        },
        { name: "events", testMatch: /events\.spec\.ts/, dependencies: ["activities"] },
        // Club-defined roles (P1.15 A2): changes SVK's own role.
        { name: "roles", testMatch: /roles\.spec\.ts/, dependencies: ["events"] },
        // At least two administrators (P1.15 A3): suspends SVK's third administrator.
        {
          name: "administrators",
          testMatch: /administrators\.spec\.ts/,
          dependencies: ["roles"],
        },
        // The file archive (P2.2): uploads a file to IK Norrbacka's F2015.
        {
          name: "documents",
          testMatch: /documents\.spec\.ts/,
          dependencies: ["administrators"],
        },
        // Announcements (P2.3): Göran writes one to IK Norrbacka's board.
        {
          name: "announcements",
          testMatch: /announcements\.spec\.ts/,
          dependencies: ["documents"],
        },
        { name: "cleanup", testMatch: /cleanup\.spec\.ts/, dependencies: ["announcements"] },
      ],
});
