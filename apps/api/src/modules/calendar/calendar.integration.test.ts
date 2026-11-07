// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscriptions through the HTTP API (P1.11, ADR 0044): creating
// and managing feeds, fetching them (iCalendar, ETag/304, revoked = 404),
// what a feed contains (only the owner's family by name, cancelled events,
// answer links), answering from a link, and group feeds.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildFamily,
  buildPerson,
  type BuiltClub,
  type BuiltFamily,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;
let club: BuiltClub;
let family: BuiltFamily;
let coach: BuiltPerson;
let outsider: BuiltPerson;
let teamId: string;
let trainingId: string;
let cancelledId: string;

const DAY = 86_400_000;
const at = (days: number, hours = 17) =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 11) +
  `${String(hours).padStart(2, "0")}:00:00Z`;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    CALENDAR_TOKEN_KEY: "calendar-token-key-for-tests-0123456789",
    PUBLIC_WEB_URL: "https://clubadmin.test",
    ...NO_RATE_LIMITS,
  });
  club = await buildClub(s);
  family = await buildFamily(s, { club });
  coach = await buildPerson(s, { givenName: "Kim", familyName: "Coachsson" });
  outsider = await buildPerson(s);
  await s.memberships.addMember(club.ctx, coach.id);
  const team = await s.groups.createGroup(club.ctx, { name: "F2017", kind: "team" });
  teamId = team.id;
  await s.memberships.addToGroup(club.ctx, team.id, family.child.id, "member");
  await s.memberships.addToGroup(club.ctx, team.id, coach.id, "head_coach");
  const training = await s.activities.createActivity(club.ctx, team.id, {
    kind: "training",
    title: "Training F2017",
    startsAt: at(2),
    endsAt: at(2, 18),
  });
  trainingId = training.activity.id;
  const match = await s.activities.createActivity(club.ctx, team.id, {
    kind: "match",
    title: "Match",
    startsAt: at(5),
    endsAt: at(5, 19),
  });
  cancelledId = match.activity.id;
  await s.activities.cancelActivity(club.ctx, cancelledId, { reason: "Rain" });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

async function call(
  personId: string | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; prefix?: boolean } = {},
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: options.prefix === false ? url : `/api/v1${url}`,
      headers: {
        ...(personId ? { authorization: `Bearer ${await devToken(personId)}` } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}

const secretOf = (url: string) => url.slice(url.lastIndexOf("/") + 1).replace(/\.ics$/, "");
const fetchFeed = (secret: string, headers: Record<string, string> = {}) =>
  call(null, "GET", `/cal/${secret}.ics`, { prefix: false, headers });
/** The calendar text with folded lines joined (RFC 5545 3.1). */
const unfold = (body: string) => body.replace(/\r\n /g, "");

describe("my schedule feeds", () => {
  let secret: string;

  it("creates a feed for chosen children and shows its URL once", async () => {
    const res = await call(family.guardian.id, "POST", "/me/calendar-feeds", {
      body: { personIds: [family.child.id], label: "Family" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{
      httpsUrl: string;
      webcalUrl: string;
      feed: { people: { id: string }[] };
    }>();
    expect(created.httpsUrl).toMatch(/^https:\/\/clubadmin\.test\/cal\/[A-Za-z0-9_-]+\.ics$/);
    expect(created.webcalUrl.startsWith("webcal://clubadmin.test/cal/")).toBe(true);
    expect(created.feed.people.map((p) => p.id)).toEqual([family.child.id]);
    secret = secretOf(created.httpsUrl);
    const list = await call(family.guardian.id, "GET", "/me/calendar-feeds");
    expect(JSON.stringify(list.json())).not.toContain(secret);
  });

  it("serves the child's activities with names of the family only, cancelled ones and answer links", async () => {
    const res = await fetchFeed(secret);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    const body = unfold(res.body);
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain(`UID:${trainingId}@clubadmin.test`);
    expect(body).toContain(`SUMMARY:${family.child.givenName}: Training F2017`);
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).toMatch(/https:\/\/clubadmin\.test\/answer\/[A-Za-z0-9_-]+/);
    expect(body).not.toContain(coach.givenName);
    expect(body).not.toContain(coach.familyName);
    // The same body again answers 304.
    const again = await fetchFeed(secret, { "if-none-match": String(res.headers.etag) });
    expect(again.statusCode).toBe(304);
  });

  it("answers from a link after a confirmation, as the owner on behalf of the child", async () => {
    const body = unfold((await fetchFeed(secret)).body);
    const tokens = [...body.matchAll(/\/answer\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
    const info = await Promise.all(
      tokens.map(async (token) => ({
        token,
        res: await call(null, "GET", `/calendar-answers/${token}`),
      })),
    );
    if (!info.some((i) => i.res.statusCode === 200)) {
      throw new Error(info.map((i) => `${i.res.statusCode} ${i.res.body}`).join("\n"));
    }
    const coming = info.find(
      (i) => i.res.statusCode === 200 && i.res.json<{ status: string }>().status === "attending",
    )!;
    expect(coming.res.json()).toMatchObject({
      personName: family.child.givenName,
      currentAnswer: null,
      open: true,
    });
    const answer = await call(null, "POST", `/calendar-answers/${coming.token}`);
    expect(answer.statusCode).toBe(200);
    const { rows } = await t.query<{ id: string; status: string }>(
      "admin",
      "SELECT id, status FROM activity_responses WHERE activity_id = $1 AND person_id = $2",
      [trainingId, family.child.id],
    );
    expect(rows[0]?.status).toBe("attending");
    expect(
      (
        await t.query<{ changed_fields: string[] }>(
          "admin",
          "SELECT changed_fields FROM audit.events WHERE resource_id = $1",
          [rows[0]!.id],
        )
      ).rows.map((r) => r.changed_fields),
    ).toContainEqual(["via_calendar_link"]);
    // A changed token is not a link.
    const tampered = `${coming.token.slice(0, -2)}xx`;
    expect((await call(null, "GET", `/calendar-answers/${tampered}`)).statusCode).toBe(404);
  });

  it("renames, regenerates (the old URL stops) and revokes", async () => {
    const list = await call(family.guardian.id, "GET", "/me/calendar-feeds");
    const feedId = list.json<{ items: { id: string }[] }>().items[0]!.id;
    const renamed = await call(family.guardian.id, "PATCH", `/me/calendar-feeds/${feedId}`, {
      body: { label: "Elsa" },
    });
    expect(renamed.json()).toMatchObject({ label: "Elsa" });
    const regenerated = await call(
      family.guardian.id,
      "POST",
      `/me/calendar-feeds/${feedId}/regenerate`,
    );
    expect(regenerated.statusCode).toBe(200);
    const fresh = secretOf(regenerated.json<{ httpsUrl: string }>().httpsUrl);
    expect((await fetchFeed(secret)).statusCode).toBe(404);
    expect((await fetchFeed(fresh)).statusCode).toBe(200);
    const newId = regenerated.json<{ feed: { id: string } }>().feed.id;
    expect(await auditActionsOf(t, newId)).toContain("calendar_feed.regenerated");
    // Someone else's feed does not exist for them.
    expect((await call(outsider.id, "DELETE", `/me/calendar-feeds/${newId}`)).statusCode).toBe(404);
    expect(
      (await call(family.guardian.id, "DELETE", `/me/calendar-feeds/${newId}`)).statusCode,
    ).toBe(200);
    expect((await fetchFeed(fresh)).statusCode).toBe(404);
    expect((await fetchFeed("not-a-real-secret-0123456789abcdef")).statusCode).toBe(404);
  });

  it("refuses people whose schedule the caller does not see, and more than ten feeds", async () => {
    const res = await call(outsider.id, "POST", "/me/calendar-feeds", {
      body: { personIds: [family.child.id] },
    });
    expect(res.statusCode).toBe(404);
    for (let i = 0; i < 10; i++) {
      expect((await call(outsider.id, "POST", "/me/calendar-feeds", { body: {} })).statusCode).toBe(
        201,
      );
    }
    const eleventh = await call(outsider.id, "POST", "/me/calendar-feeds", { body: {} });
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json<{ detail: string }>().detail).toBe("too_many_feeds");
  });
});

describe("group feeds", () => {
  it("lets readers of the group calendar subscribe; the feed names nobody", async () => {
    const res = await call(coach.id, "POST", `/groups/${teamId}/calendar-feeds`, { body: {} });
    expect(res.statusCode).toBe(201);
    const body = unfold(
      (await fetchFeed(secretOf(res.json<{ httpsUrl: string }>().httpsUrl))).body,
    );
    expect(body).toContain("SUMMARY:Training F2017");
    expect(body).not.toContain(family.child.givenName);
    expect(body).not.toContain(coach.givenName);
    expect(
      (await call(outsider.id, "POST", `/groups/${teamId}/calendar-feeds`, { body: {} }))
        .statusCode,
    ).toBe(404);
  });
});
