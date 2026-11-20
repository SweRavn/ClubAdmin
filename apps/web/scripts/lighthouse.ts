// SPDX-License-Identifier: AGPL-3.0-only
// Lighthouse CI on the production build (docs/performance.md, ADR 0027):
// home and a group page as a signed-in member, and the home page of someone
// with something in progress (P1.14), mobile profile, budgets in
// lighthouserc.json. Reports stay on disk (.lighthouseci), nothing is uploaded.
// Lighthouse CI runs at an exact version through `pnpm dlx`, outside the
// workspace's dependencies: its dependency tree (Puppeteer's browser
// downloader) has known vulnerabilities without fixes, and it is a CI tool
// that never ships.
//
//   node apps/web/scripts/lighthouse.ts [baseUrl]   (needs .env.local values and CHROME_PATH)

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { createTestSession } from "./test-session.ts";

const LHCI = "@lhci/cli@0.15.1";

/** Erik Johansson (demo data): leader in two clubs, sees a protected member. */
const PERSON = "0199a000-0000-7000-8000-000000000005";
const GROUP = "0199a000-0000-7000-8002-000000000007";
/**
 * Peter Sund: a manager hand-over waits for him, so his home page has "In
 * progress" (P1.14: that section must not hold back the largest paint).
 */
const PERSON_IN_PROGRESS = "0199a000-0000-7000-8000-000000000016";

const base = (process.argv[2] ?? "https://clubadmin.localhost").replace(/\/$/, "");

async function autorun(personId: string, urls: readonly string[]): Promise<number> {
  const { id, csrf } = await createTestSession(personId);
  const headers = JSON.stringify({ Cookie: `__Host-session=${id}; __Host-csrf=${csrf}` });
  const result = spawnSync(
    "pnpm",
    [
      "dlx",
      LHCI,
      "autorun",
      ...urls.map((url) => `--collect.url=${base}${url}`),
      `--collect.settings.extraHeaders=${headers}`,
    ],
    { stdio: "inherit", shell: false },
  );
  summarise();
  return result.status ?? 1;
}

type Audit = { numericValue?: number; details?: { items?: unknown[] } };
type Report = { finalUrl: string; audits: Record<string, Audit> };

/**
 * One line per run, and what made the largest paint late (the reports stay
 * on the runner): the element, its phases, the document's timing and the
 * main thread's work. CI cannot be compared with a laptop otherwise.
 */
function summarise(): void {
  const dir = ".lighthouseci";
  for (const file of readdirSync(dir).filter((f) => /^lhr-.*\.json$/.test(f))) {
    const report = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Report;
    const a = report.audits;
    const ms = (id: string) => Math.round(a[id]?.numericValue ?? NaN);
    const items = (id: string) => (a[id]?.details?.items ?? []) as Record<string, unknown>[];
    const lcpElement = items("largest-contentful-paint-element") as {
      items?: { node?: { nodeLabel?: string }; phase?: string; timing?: number }[];
    }[];
    const element = lcpElement[0]?.items?.[0]?.node?.nodeLabel?.slice(0, 40) ?? "?";
    const phases = (lcpElement[1]?.items ?? [])
      .map((p) => `${p.phase}=${Math.round(p.timing ?? 0)}`)
      .join(" ");
    const doc = items("network-requests").find((r) => r.resourceType === "Document") as
      { networkRequestTime?: number; networkEndTime?: number; transferSize?: number } | undefined;
    const work = items("mainthread-work-breakdown")
      .slice(0, 4)
      .map((w) => `${String(w.group)}=${Math.round(Number(w.duration))}`)
      .join(" ");
    console.log(
      [
        `[lighthouse] ${new URL(report.finalUrl).pathname}`,
        `LCP=${ms("largest-contentful-paint")} FCP=${ms("first-contentful-paint")} TBT=${ms("total-blocking-time")} TTFB=${ms("server-response-time")}`,
        `element="${element}" ${phases}`,
        `document=${Math.round(doc?.networkRequestTime ?? NaN)}..${Math.round(doc?.networkEndTime ?? NaN)}ms ${doc?.transferSize ?? "?"}B`,
        `main-thread: ${work}`,
      ].join(" | "),
    );
  }
}

const first = await autorun(PERSON, ["/", `/groups/${GROUP}`]);
const second = await autorun(PERSON_IN_PROGRESS, ["/"]);
process.exit(first || second);
