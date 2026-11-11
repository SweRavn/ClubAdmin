// SPDX-License-Identifier: AGPL-3.0-only
// Request budgets (docs/performance.md, ADR 0040): what each request the
// apps make costs the database, measured independently of the hardware:
// the number of SQL statements and the database pages (8 KB blocks) they
// read, from pg_stat_statements. Measured on the demo scenario, then again
// after adding 40 load clubs and the club of 10,000 members (about 30 times
// the data): the statements must stay the same and the pages must not grow
// in proportion to the data (at most 2.5 times plus 20 pages for 30 times the
// data: index levels, never a scan). Every endpoint the mobile app calls must
// be listed here (checked against apps/mobile/src).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDemoData } from "./seed/demodata.ts";
import { seed } from "./seed/runner.ts";
import { SeedClock } from "./seed/time.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "./testing/oidc.ts";
import { createCoreServices } from "./testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "./testing/test-app.ts";

const data = loadDemoData();
const key = (k: string) => {
  const found = [...data.personas, ...data.clubs, ...data.groups].find((x) => x.key === k);
  if (!found) throw new Error(`unknown key ${k}`);
  return found.id;
};
const LOAD_CLUBS = 40;
/** The billing-on CI leg (P1.13) measures the billing pages too. */
const BILLING = ["true", "1"].includes((process.env.BILLING_ENABLED ?? "").toLowerCase());

let t: TestDatabase;
let app: TestApp;
let ids: { activity: string; event: string };

interface Case {
  /** "GET /api/v1/me/schedule" as the app writes it (path parameters in braces). */
  route: string;
  persona: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: () => string;
  body?: () => Record<string, unknown>;
  /** At most this many SQL statements (transaction control and context settings not counted). */
  statements: number;
  /** At most this many 8 KB pages read (shared buffers hit or read) on the larger data. */
  pages: number;
  /** The token carries a second factor (club managers' audit log, P1.9). */
  mfa?: boolean;
}

const range = () => {
  const from = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const to = new Date(Date.now() + 28 * 86_400_000).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`;
};

/** Billing (P1.13, BILLING_ENABLED only): the club's billing page and the operator console. */
const BILLING_CASES: Case[] = [
  {
    route: "GET /api/v1/clubs/{clubId}/subscription",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/subscription`,
    statements: 6,
    pages: 60,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/billing/plans",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/billing/plans`,
    statements: 7,
    pages: 60,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/billing/account",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/billing/account`,
    statements: 2,
    pages: 30,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/invoices",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/invoices`,
    statements: 4,
    pages: 60,
  },
  {
    route: "GET /api/v1/billing/subscriptions",
    persona: "operator",
    method: "GET",
    // A page of three: the cost of a page, never of all clubs.
    url: () => "/api/v1/billing/subscriptions?limit=3",
    statements: 3,
    pages: 60,
    mfa: true,
  },
  {
    route: "GET /api/v1/billing/invoices",
    persona: "operator",
    method: "GET",
    url: () => "/api/v1/billing/invoices?limit=3",
    statements: 4,
    pages: 60,
    mfa: true,
  },
];

/** The requests of the apps, with their budgets. */
const CASES: Case[] = [
  // The club's access state and plan (banners; P1.13 in the apps).
  {
    route: "GET /api/v1/clubs/{clubId}/entitlements",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/entitlements`,
    statements: 4,
    pages: 40,
  },
  ...(BILLING ? BILLING_CASES : []),
  // Group administration (P1.10a, web only).
  {
    route: "GET /api/v1/groups/{groupId}/candidates",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/candidates?q=an&function=member`,
    statements: 3,
    pages: 130,
  },
  {
    route: "GET /api/v1/groups/{groupId}/archive-preview",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/archive-preview`,
    statements: 4,
    pages: 60,
  },
  {
    route: "GET /api/v1/groups/{groupId}/seasons",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/seasons`,
    statements: 2,
    pages: 50,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/seasons",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/seasons`,
    statements: 2,
    pages: 10,
  },
  // Protected identity (P1.12): Samira reads who opened Nadia's profile
  // (demo views in IKN); Anna, with a second factor, reads SVK's log.
  {
    route: "GET /api/v1/people/{personId}/access-log",
    persona: "samira",
    method: "GET",
    url: () => `/api/v1/people/${key("nadia")}/access-log`,
    statements: 3,
    pages: 30,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/profile-views",
    persona: "anna",
    method: "GET",
    mfa: true,
    url: () => `/api/v1/clubs/${key("svk")}/profile-views`,
    statements: 4,
    pages: 40,
  },
  // Calendar subscriptions (P1.11): the list (web and app) and the feeds
  // calendar apps fetch: Anna's "My schedule" for two children in two clubs,
  // Erik's F2017 group calendar (demo secrets, docs/seed-data.md). Both feeds
  // run the schedule query of the owner's family (answer links), as
  // GET /api/v1/me/schedule does. The answer links (GET/POST
  // /api/v1/calendar-answers/{token}) read one schedule entry and are left out.
  {
    route: "GET /api/v1/me/calendar-feeds",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/calendar-feeds",
    statements: 2,
    pages: 8,
  },
  {
    // P1.14: SVK F2017 runs until further notice, so the feed's 370 days ahead
    // hold about 105 of its sessions (12 before): the pages follow the feed's
    // size, which the window bounds, not the amount of data.
    route: "GET /cal/{secret}.ics (my schedule)",
    persona: "anna",
    method: "GET",
    url: () => "/cal/demo-anna-my-schedule.ics",
    statements: 6,
    pages: 560,
  },
  {
    route: "GET /cal/{secret}.ics (group)",
    persona: "erik",
    method: "GET",
    url: () => "/cal/demo-erik-f2017.ics",
    statements: 10,
    pages: 640,
  },
  // Waiting lists (P1.10b, web only). Writes that change the queue
  // (apply, offer, admit, accept) cannot run twice on the same data; their
  // statements are counted in waitlists.integration.test.ts.
  {
    route: "GET /api/v1/groups/{groupId}/waitlist",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/waitlist`,
    statements: 3,
    pages: 400,
  },
  {
    route: "GET /api/v1/groups/{groupId}/waitlist/summary",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/waitlist/summary`,
    statements: 3,
    pages: 110,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/waitlists",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/waitlists`,
    statements: 3,
    pages: 320,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/open-groups",
    persona: "henrik",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/open-groups`,
    statements: 1,
    pages: 90,
  },
  {
    route: "GET /api/v1/me/waitlists",
    persona: "henrik",
    method: "GET",
    url: () => "/api/v1/me/waitlists",
    statements: 6,
    pages: 110,
  },
  // Club-defined roles (P1.15 A2): the app's "my roles" (the relationship
  // set plus the club's roles by club), the roles page (roles with their
  // permissions and holder counts by the role indexes, and the people who
  // gave themselves a role) and who holds a permission (keyset by person).
  {
    route: "GET /api/v1/me/permissions",
    persona: "erik",
    method: "GET",
    url: () => `/api/v1/me/permissions?clubId=${key("svk")}`,
    statements: 1,
    pages: 160,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/roles",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/roles`,
    statements: 4,
    pages: 170,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/permissions/{permission}/holders",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/permissions/group.participate/holders?limit=50`,
    statements: 2,
    pages: 90,
  },
  // History panels and the audit log (P1.9, web only; ADR 0042). Read
  // through the history pool: the scope, the club rows' history, the global
  // rows' history, the current rows behind the page and the names it
  // mentions in one read-only transaction (at most five statements), then
  // the people for the presenter; the rest is authorization. The pages are
  // mostly one index probe per record and monthly partition: bounded by the
  // scope and the retention, not by the club's size.
  {
    route: "GET /api/v1/people/{personId}/history",
    // A member's history is the registrar's (P1.15 A2): Anna is also SVK's registrar.
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/people/${key("elsa")}/history?clubId=${key("svk")}`,
    statements: 9,
    pages: 900,
  },
  {
    route: "GET /api/v1/groups/{groupId}/history",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/history`,
    statements: 6,
    pages: 300,
  },
  {
    route: "GET /api/v1/activities/{activityId}/history",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/activities/${ids.activity}/history`,
    statements: 7,
    pages: 250,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/history",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/history`,
    statements: 4,
    pages: 100,
    mfa: true,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/audit-events",
    persona: "sara",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/audit-events`,
    statements: 4,
    pages: 60,
    mfa: true,
  },
  {
    route: "GET /api/v1/me",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me",
    // The person, the account and a pending deletion (P1.8b).
    statements: 3,
    pages: 10,
  },
  {
    route: "GET /api/v1/me/clubs",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/clubs",
    statements: 1,
    pages: 25,
  },
  {
    route: "GET /api/v1/me/groups",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/groups",
    statements: 3,
    pages: 35,
  },
  {
    route: "GET /api/v1/me/wards",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/wards",
    statements: 3,
    pages: 50,
  },
  {
    route: "GET /api/v1/me/wards/{personId}/guardians",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/me/wards/${key("elsa")}/guardians`,
    statements: 8,
    pages: 90,
  },
  {
    route: "GET /api/v1/me/schedule",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/me/schedule?${range()}`,
    statements: 4,
    pages: 220,
  },
  {
    route: "GET /api/v1/me/events",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/events?limit=50",
    statements: 17,
    pages: 350,
  },
  {
    route: "GET /api/v1/me/sessions",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/sessions",
    statements: 0,
    pages: 0,
  },
  {
    route: "GET /api/v1/me/notifications",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/notifications",
    statements: 4,
    pages: 20,
  },
  {
    route: "GET /api/v1/me/notifications/unread-count",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/notifications/unread-count",
    statements: 1,
    pages: 10,
  },
  {
    route: "GET /api/v1/me/notification-settings",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/notification-settings",
    statements: 1,
    pages: 10,
  },
  {
    route: "GET /api/v1/clubs/{clubId}",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}`,
    statements: 4,
    pages: 25,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/groups",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/groups?limit=200`,
    statements: 1,
    pages: 10,
  },
  {
    route: "GET /api/v1/groups/{groupId}",
    persona: "erik",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}`,
    // The group, its owners, the number waiting (P1.10b) and (owners: Erik) its
    // places and whether it can be deleted (P1.10a).
    statements: 7,
    pages: 130,
  },
  {
    route: "GET /api/v1/groups/{groupId}/members",
    persona: "erik",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/members?limit=50`,
    statements: 3,
    pages: 250,
  },
  {
    route: "GET /api/v1/people/{personId}",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/people/${key("elsa")}?clubId=${key("svk")}`,
    statements: 7,
    pages: 110,
  },
  {
    route: "GET /api/v1/activities/{activityId}",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/activities/${ids.activity}`,
    statements: 7,
    pages: 150,
  },
  {
    route: "GET /api/v1/activities/{activityId}/responses/summary",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/activities/${ids.activity}/responses/summary`,
    statements: 6,
    pages: 200,
  },
  {
    route: "GET /api/v1/activities/{activityId}/responses",
    persona: "erik",
    method: "GET",
    url: () => `/api/v1/activities/${ids.activity}/responses?limit=200`,
    statements: 6,
    pages: 320,
  },
  {
    route: "GET /api/v1/activities/{activityId}/attendance",
    persona: "erik",
    method: "GET",
    url: () => `/api/v1/activities/${ids.activity}/attendance`,
    statements: 8,
    pages: 260,
  },
  {
    route: "GET /api/v1/events/{eventId}",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/events/${ids.event}`,
    statements: 14,
    pages: 170,
  },
  {
    route: "GET /api/v1/meta/client",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/meta/client",
    statements: 0,
    pages: 0,
  },
  {
    route: "GET /api/v1/meta/source",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/meta/source",
    statements: 0,
    pages: 0,
  },
  {
    route: "PUT /api/v1/activities/{activityId}/responses/{personId}",
    persona: "anna",
    method: "PUT",
    url: () => `/api/v1/activities/${ids.activity}/responses/${key("elsa")}`,
    body: () => ({ status: "attending" }),
    statements: 9,
    pages: 220,
  },
  {
    route: "POST /api/v1/me/notifications/read",
    persona: "anna",
    method: "POST",
    url: () => "/api/v1/me/notifications/read",
    body: () => ({ ids: [ids.activity] }),
    statements: 2,
    pages: 10,
  },
  // Privacy (P1.8a).
  {
    route: "GET /api/v1/me/consents",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/consents",
    statements: 4,
    pages: 160,
  },
  {
    route: "GET /api/v1/people/{personId}/consents",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/people/${key("elsa")}/consents?clubId=${key("svk")}`,
    statements: 7,
    pages: 60,
  },
  {
    route: "PUT /api/v1/people/{personId}/consents/{purpose}",
    persona: "anna",
    method: "PUT",
    url: () => `/api/v1/people/${key("elsa")}/consents/video_publication?clubId=${key("svk")}`,
    body: () => ({ textVersion: "default:1" }),
    statements: 6,
    pages: 60,
  },
  {
    route: "GET /api/v1/groups/{groupId}/consents",
    persona: "erik",
    method: "GET",
    url: () => `/api/v1/groups/${key("svk-f2017")}/consents`,
    statements: 5,
    pages: 400,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/privacy",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/privacy`,
    statements: 4,
    pages: 20,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/privacy-policy",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/privacy-policy`,
    statements: 3,
    pages: 20,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/setting-decisions",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/setting-decisions`,
    statements: 2,
    pages: 20,
  },
  {
    route: "GET /api/v1/clubs/{clubId}/consent-texts",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/clubs/${key("svk")}/consent-texts?purpose=photo_publication`,
    statements: 6,
    pages: 30,
  },
  {
    route: "GET /api/v1/me/clubs/{clubId}/assignments",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/me/clubs/${key("svk")}/assignments`,
    statements: 4,
    pages: 25,
  },
  {
    route: "GET /api/v1/me/clubs/{clubId}/leave-preview",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/me/clubs/${key("svk")}/leave-preview?personId=${key("elsa")}`,
    statements: 5,
    pages: 30,
  },
  {
    route: "GET /api/v1/me/data-exports",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/data-exports",
    // The requests, their subjects through the presenter (P1.8b).
    statements: 3,
    pages: 20,
  },
  {
    route: "GET /api/v1/me/account/deletion",
    persona: "anna",
    method: "GET",
    url: () => "/api/v1/me/account/deletion",
    // Wards and their logins, assignments in every club, a pending request.
    // Anna also holds the registrar role in her club since P1.15 A2: one more
    // assignment to explain, a few pages, not a cost that grows with the data.
    statements: 3,
    pages: 90,
  },
  {
    route: "GET /api/v1/me/wards/{personId}/erasure",
    persona: "anna",
    method: "GET",
    url: () => `/api/v1/me/wards/${key("elsa")}/erasure`,
    // As the deletion preview, for one ward.
    statements: 4,
    pages: 75,
  },
  {
    route: "PATCH /api/v1/me/preferences",
    persona: "anna",
    method: "PATCH",
    url: () => "/api/v1/me/preferences",
    body: () => ({ theme: "dark" }),
    statements: 1,
    pages: 10,
  },
];

/**
 * Endpoints the app calls that are measured elsewhere or are not worth a
 * budget here, with the reason.
 */
const NOT_HERE: Record<string, string> = {
  "PUT /api/v1/people/{personId}/protection":
    "a rare write: one lock, one update, audit and outbox (protection tests)",
  "POST /api/v1/me/calendar-feeds":
    "once per subscription; the people check and one insert (calendar tests)",
  "POST /api/v1/me/account/deletion":
    "needs a recent login; the preview's statements and one insert (privacy tests)",
  "DELETE /api/v1/me/account/deletion": "one update by key, plus an audit row",
  "PUT /api/v1/me/push-devices": "needs a push provider; one upsert by token hash",
  "DELETE /api/v1/me/push-devices/{deviceId}": "one delete by primary key",
  "PUT /api/v1/me/notification-settings": "one account row",
  "DELETE /api/v1/me/sessions/{sessionId}": "Valkey only, plus an audit row",
  "PUT /api/v1/activities/{activityId}/attendance": "leaders after a session; attendance tests",
  "DELETE /api/v1/activities/{activityId}/responses/{personId}": "as the PUT",
  "PUT /api/v1/events/{eventId}/registrations/{personId}": "sign-up under a lock; events tests",
  "DELETE /api/v1/events/{eventId}/registrations/{personId}": "as the sign-up",
  "POST /api/v1/events/{eventId}/registrations/{personId}/accept": "as the sign-up",
  "POST /api/v1/events/{eventId}/registrations/{personId}/decline": "as the sign-up",
  "DELETE /api/v1/people/{personId}/consents/{purpose}": "as giving one",
  "POST /api/v1/me/clubs/{clubId}/leave": "once per membership; privacy tests",
  "DELETE /api/v1/me/clubs/{clubId}/assignments/{assignmentId}": "once per assignment",
};

interface Measure {
  statements: number;
  pages: number;
}

async function measure(c: Case): Promise<Measure> {
  const token = await devToken(key(c.persona), {
    sid: `budget-${c.persona}`,
    ...(c.mfa ? { mfa: true } : {}),
  });
  const request = async () => {
    const res = await app.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: c.method,
        url: c.url(),
        headers: { authorization: `Bearer ${token}` },
        ...(c.body ? { payload: c.body() } : {}),
      } satisfies InjectOptions);
    expect(res.statusCode, `${c.route}: ${res.body.slice(0, 200)}`).toBeLessThan(300);
  };
  // Warm: the connection's catalogue cache, the relationship set and the protected sets.
  await request();
  await request();
  // The steady state: the cheapest of three requests. A cache that expires
  // during one of them (slower CI machines) is not the request's own cost.
  // pg_stat_statements is shared by every test database on the server: when
  // other test files fill it, it evicts entries (dealloc), possibly this
  // request's. Such a run measures nothing and is repeated.
  const dealloc = async () =>
    (
      await t.query<{ n: string }>(
        "admin",
        "SELECT dealloc::text AS n FROM pg_stat_statements_info",
      )
    ).rows[0]!.n;
  let best: Measure | null = null;
  for (let run = 0, valid = 0; valid < 3; run++) {
    if (run >= 20) throw new Error(`${c.route}: pg_stat_statements kept evicting entries`);
    const before = await dealloc();
    await t.query(
      "admin",
      "SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname = current_database()), 0)",
    );
    await request();
    const { rows } = await t.query<Measure>(
      "admin",
      `SELECT coalesce(sum(calls), 0)::int AS statements,
              coalesce(sum(shared_blks_hit + shared_blks_read), 0)::int AS pages
       FROM pg_stat_statements
       WHERE toplevel AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND query !~* '^\\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)' AND query !~* 'pg_stat_statements'`,
    );
    const m = rows[0]!;
    if ((await dealloc()) !== before) continue;
    valid++;
    if (
      !best ||
      m.statements < best.statements ||
      (m.statements === best.statements && m.pages < best.pages)
    ) {
      best = m;
    }
  }
  if (process.env.BUDGET_DEBUG) {
    const detail = await t.query<{ calls: number; pages: number; query: string }>(
      "admin",
      `SELECT calls::int, (shared_blks_hit + shared_blks_read)::int AS pages, left(regexp_replace(query, '\\s+', ' ', 'g'), 220) AS query
       FROM pg_stat_statements
       WHERE toplevel AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND query !~* '^\\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)' AND query !~* 'pg_stat_statements'
       ORDER BY pages DESC`,
    );
    // eslint-disable-next-line no-console -- BUDGET_DEBUG only
    console.log(
      `### ${c.route}\n${detail.rows.map((r) => `${r.calls}x ${r.pages}p ${r.query}`).join("\n")}`,
    );
  }
  return best!;
}

function mobileRoutes(): string[] {
  const root = join(import.meta.dirname, "../../mobile/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !name.includes(".test.")) files.push(path);
    }
  };
  walk(root);
  const routes = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(
      /api\.(GET|POST|PUT|PATCH|DELETE)\("([^"]+)"/g,
    )) {
      routes.add(`${m[1]} ${m[2]}`);
    }
  }
  return [...routes].sort();
}

const before = new Map<string, Measure>();
const after = new Map<string, Measure>();

beforeAll(async () => {
  t = await createTestDatabase();
  await t.query("admin", "CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  await t.query("admin", "INSERT INTO app_meta.seed_mode DEFAULT VALUES");
  const env = {
    db: t.db,
    services: createCoreServices(t.db),
    clock: new SeedClock(),
    addPlatformOperator: async (personId: string) => {
      await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [personId]);
    },
    admin: async (sql: string) => {
      await t.query("admin", sql);
    },
    billingEnabled: BILLING,
  };
  await seed(env, { scenario: "demo", data });
  await t.query("admin", "ANALYZE");
  const { rows } = await t.query<{ activity: string; event: string }>(
    "admin",
    `SELECT
       (SELECT a.id FROM activities a JOIN activity_groups ag ON ag.activity_id = a.id
        WHERE ag.group_id = $1 AND a.status = 'scheduled' AND a.starts_at > now()
          AND a.response_mode = 'requested' ORDER BY a.starts_at LIMIT 1) AS activity,
       (SELECT id FROM events WHERE title = 'Höstcupen i Strandviken') AS event`,
    [key("svk-f2017")],
  );
  ids = rows[0]!;
  if (process.env.BUDGET_EXPLAIN) {
    // The plans of every statement into the PostgreSQL log (docker logs).
    for (const setting of [
      "session_preload_libraries = 'auto_explain'",
      "auto_explain.log_min_duration = 0",
      "auto_explain.log_analyze = on",
      "auto_explain.log_buffers = on",
      // Also the statements inside SQL functions (app.erasure_assignments, P1.8b).
      "auto_explain.log_nested_statements = on",
    ]) {
      await t.query("admin", `ALTER DATABASE ${t.name} SET ${setting}`);
    }
  }
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    // As in production: relationship and protected sets come from Valkey.
    VALKEY_URL: process.env.VALKEY_URL ?? "redis://127.0.0.1:6379",
    // One connection, warm after the first requests: a new connection reads the
    // catalogue first (hundreds of pages once), which says nothing about a request.
    DATABASE_POOL_MAX: "1",
    // Calendar feeds (P1.11) are measured as rendered, not from the cache.
    CALENDAR_TOKEN_KEY: "calendar-token-key-for-tests-0123456789",
    CALENDAR_FEED_CACHE_SECONDS: "0",
    ...NO_RATE_LIMITS,
  });
  for (const c of CASES) before.set(c.route, await measure(c));
  // About 30 times the people, activities, answers and notices.
  await seed(env, { scenario: "load", size: LOAD_CLUBS });
  await t.query("admin", "ANALYZE");
  for (const c of CASES) after.set(c.route, await measure(c));
}, 900_000);
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("request budgets", () => {
  it("covers every endpoint the mobile app calls", () => {
    const listed = new Set([...CASES.map((c) => c.route), ...Object.keys(NOT_HERE)]);
    expect(mobileRoutes().filter((r) => !listed.has(r))).toEqual([]);
  });

  it.each(CASES.map((c) => [c.route, c] as const))(
    "%s stays within its budget and does not grow with the data",
    (_route, c) => {
      const small = before.get(c.route)!;
      const large = after.get(c.route)!;
      const summary = `${c.route}: ${small.statements}→${large.statements} statements, ${small.pages}→${large.pages} pages`;
      expect(large.statements, summary).toBeLessThanOrEqual(c.statements);
      expect(large.statements, summary).toBe(small.statements);
      expect(large.pages, summary).toBeLessThanOrEqual(c.pages);
      // About 30 times the data may add index levels and a few pages (up to
      // about twice as many for these small numbers), never pages in proportion to it.
      expect(large.pages, summary).toBeLessThanOrEqual(Math.ceil(small.pages * 2.5) + 20);
    },
  );
});
