// SPDX-License-Identifier: AGPL-3.0-only
// Lighthouse CI on the production build (docs/performance.md, ADR 0027):
// home and a group page as a signed-in member, mobile profile, budgets in
// lighthouserc.json. Reports stay on disk (.lighthouseci), nothing is uploaded.
// Lighthouse CI runs at an exact version through `pnpm dlx`, outside the
// workspace's dependencies: its dependency tree (Puppeteer's browser
// downloader) has known vulnerabilities without fixes, and it is a CI tool
// that never ships.
//
//   node apps/web/scripts/lighthouse.ts [baseUrl]   (needs .env.local values and CHROME_PATH)

import { spawnSync } from "node:child_process";

import { createTestSession } from "./test-session.ts";

const LHCI = "@lhci/cli@0.15.1";

/** Erik Johansson (demo data): leader in two clubs, sees a protected member. */
const PERSON = "0199a000-0000-7000-8000-000000000005";
const GROUP = "0199a000-0000-7000-8002-000000000007";

const base = (process.argv[2] ?? "https://clubadmin.localhost").replace(/\/$/, "");
const { id, csrf } = await createTestSession(PERSON);
const headers = JSON.stringify({ Cookie: `__Host-session=${id}; __Host-csrf=${csrf}` });
const result = spawnSync(
  "pnpm",
  [
    "dlx",
    LHCI,
    "autorun",
    `--collect.url=${base}/`,
    `--collect.url=${base}/groups/${GROUP}`,
    `--collect.settings.extraHeaders=${headers}`,
  ],
  { stdio: "inherit", shell: false },
);
process.exit(result.status ?? 1);
