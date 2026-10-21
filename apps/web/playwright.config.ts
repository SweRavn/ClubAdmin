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
  projects: [
    // Signs up through Zitadel first, so the DEV_AUTH picker has someone to show.
    { name: "zitadel", testMatch: /zitadel\.spec\.ts/ },
    { name: "dev-auth", testMatch: /dev-auth\.spec\.ts/, dependencies: ["zitadel"] },
  ],
});
