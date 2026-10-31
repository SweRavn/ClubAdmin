// SPDX-License-Identifier: AGPL-3.0-only
// The inbox, settings, push devices and unsubscribe links through the HTTP
// API (P1.7, ADR 0039). Notices are created by the worker; here they are
// inserted directly. Everyone sees only their own notices and devices.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { unsubscribeToken } from "@clubadmin/server-kit/notifications";
import { uuidv7 } from "@clubadmin/shared";
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
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

const KEY = "notification-token-key-for-tests-0123456789";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;
let club: BuiltClub;
let family: BuiltFamily;
let other: BuiltPerson;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    NOTIFICATION_TOKEN_KEY: KEY,
    PUSH_PROVIDER: "fake",
    ...NO_RATE_LIMITS,
  });
  club = await buildClub(s);
  family = await buildFamily(s, { club });
  other = await buildPerson(s);
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

type Method = "GET" | "PUT" | "POST" | "DELETE";

async function api(
  personId: string | null,
  method: Method,
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(personId ? { authorization: `Bearer ${await devToken(personId)}` } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined
        ? { payload: options.body as Record<string, unknown> | string }
        : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

async function notice(
  recipient: string,
  values: { type?: string; category?: string; about?: string[]; params?: object } = {},
): Promise<string> {
  const id = uuidv7();
  await t.query(
    "admin",
    `INSERT INTO notifications (id, recipient_person_id, club_id, category, type, subject_type,
       subject_id, about_person_ids, params, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, 'activity', $6, $7, $8, $9)`,
    [
      id,
      recipient,
      club.id,
      values.category ?? "schedule",
      values.type ?? "activity.cancelled",
      uuidv7(),
      values.about ?? [],
      JSON.stringify(
        values.params ?? {
          title: "Training",
          startsAt: "2026-11-04T16:30:00Z",
          timeZone: "Europe/Stockholm",
        },
      ),
      `test:${id}`,
    ],
  );
  return id;
}

interface Item {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  club: { id: string; name: string } | null;
  about: { id: string; displayName: string }[];
  readAt: string | null;
}

describe("inbox", () => {
  it("lists my own notices newest first, rendered in my language, with the ward it is about", async () => {
    const g = family.guardian.id;
    await s.accounts.updatePreferences({ actorKind: "person", personId: g }, { locale: "en" });
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) ids.push(await notice(g, { about: [family.child.id] }));
    await notice(other.id);

    const first = await api(g, "GET", "/me/notifications");
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: Item[]; nextCursor: string | null }>();
    expect(page.items).toHaveLength(30);
    expect(page.items[0]!.id).toBe(ids.at(-1));
    expect(page.items[0]).toMatchObject({
      type: "activity.cancelled",
      club: { id: club.id, name: club.name },
      about: [{ id: family.child.id }],
      readAt: null,
    });
    expect(page.items[0]!.link).toMatch(/^\/activities\//);
    expect(page.items[0]!.title).toContain("Training");
    // Names never come from params: only the presenter's `about`.
    expect(page.items[0]!.title + page.items[0]!.body).not.toContain(family.child.givenName);

    const second = await api(g, "GET", `/me/notifications?cursor=${page.nextCursor}`);
    const rest = second.json<{ items: Item[]; nextCursor: string | null }>();
    expect(rest.items.map((n) => n.id)).toEqual([ids[1], ids[0]]);
    expect(rest.nextCursor).toBeNull();

    // Others never see them.
    const others = await api(other.id, "GET", "/me/notifications");
    expect(others.json<{ items: Item[] }>().items.map((n) => n.id)).not.toContain(ids[0]);
  });

  it("counts unread (up to 100) and marks read by ID or up to a notice; only my own", async () => {
    const person = await buildPerson(s);
    const a = await notice(person.id);
    const b = await notice(person.id);
    const c = await notice(person.id);
    const count = async () =>
      (await api(person.id, "GET", "/me/notifications/unread-count")).json<{ count: number }>()
        .count;
    expect(await count()).toBe(3);

    // Someone else cannot mark them.
    const foreign = await api(other.id, "POST", "/me/notifications/read", { body: { ids: [a] } });
    expect(foreign.json<{ count: number }>()).toBeDefined();
    expect(await count()).toBe(3);

    const marked = await api(person.id, "POST", "/me/notifications/read", { body: { ids: [c] } });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ count: 2 });
    await api(person.id, "POST", "/me/notifications/read", { body: { before: b } });
    expect(await count()).toBe(0);
    const unread = await api(person.id, "GET", "/me/notifications?unread=true");
    expect(unread.json<{ items: Item[] }>().items).toEqual([]);

    for (let i = 0; i < 105; i++) await notice(person.id);
    expect(await count()).toBe(100);
  });
});

describe("settings", () => {
  it("shows the defaults, saves changes with an audit event, keeps mandatory email on", async () => {
    const person = await buildPerson(s);
    const initial = await api(person.id, "GET", "/me/notification-settings");
    expect(initial.statusCode).toBe(200);
    const settings = initial.json<{
      categories: { category: string; email: string; push: boolean; emailMandatory: boolean }[];
      quietHours: { from: string; to: string } | null;
      pushPreview: boolean;
      channels: string[];
    }>();
    expect(settings.categories.find((c) => c.category === "schedule")).toMatchObject({
      email: "no_app",
      push: true,
      emailMandatory: false,
    });
    expect(settings.categories.find((c) => c.category === "club_admin")).toMatchObject({
      emailMandatory: true,
    });
    expect(settings.quietHours).toEqual({ from: "21:00", to: "07:00" });
    expect(settings.channels).toEqual(["email", "push"]);

    const categories = settings.categories.map(({ category, email, push }) => ({
      category,
      email,
      push,
    }));
    const update = (changes: object) =>
      api(person.id, "PUT", "/me/notification-settings", {
        body: { categories, quietHours: null, pushPreview: false, ...changes },
      });
    const saved = await update({
      categories: categories.map((c) =>
        c.category === "schedule" ? { ...c, email: "always", push: false } : c,
      ),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ quietHours: null, pushPreview: false });
    const again = await api(person.id, "GET", "/me/notification-settings");
    expect(
      again.json<typeof settings>().categories.find((c) => c.category === "schedule"),
    ).toMatchObject({ email: "always", push: false });
    const { rows } = await t.query<{ changed_fields: string[] }>(
      "admin",
      "SELECT changed_fields FROM audit.events WHERE action = 'account.notification_settings.updated' AND actor_person_id = $1",
      [person.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changed_fields).toEqual(
      expect.arrayContaining(["categories.schedule", "quietHours", "pushPreview"]),
    );

    const mandatory = await update({
      categories: categories.map((c) => (c.category === "account" ? { ...c, email: "never" } : c)),
    });
    expect(mandatory.statusCode).toBe(400);
    expect(detail(mandatory)).toBe("notification_mandatory");
  });
});

describe("push devices", () => {
  const token = `ExponentPushToken[${uuidv7()}]`;

  it("registers a phone once, moves it to whoever logs in on it, and removes it", async () => {
    const a = await buildPerson(s);
    const b = await buildPerson(s);
    const first = await api(a.id, "PUT", "/me/push-devices", {
      body: { token, platform: "android" },
    });
    expect(first.statusCode).toBe(200);
    const device = first.json<{ id: string; platform: string; appVariant: string }>();
    expect(device).toMatchObject({ platform: "android", appVariant: "production" });
    const again = await api(a.id, "PUT", "/me/push-devices", {
      body: { token, platform: "android" },
    });
    expect(again.json<{ id: string }>().id).toBe(device.id);
    const { rows: audits } = await t.query(
      "admin",
      "SELECT 1 FROM audit.events WHERE action = 'push_device.registered' AND resource_id = $1",
      [device.id],
    );
    expect(audits).toHaveLength(1);
    // The token is stored sealed, never in the clear.
    const { rows: stored } = await t.query<{ token_sealed: string }>(
      "admin",
      "SELECT token_sealed FROM push_devices WHERE id = $1",
      [device.id],
    );
    expect(stored[0]!.token_sealed).not.toContain(token);

    // Someone else cannot remove it.
    const foreign = await api(b.id, "DELETE", `/me/push-devices/${device.id}`);
    expect(foreign.statusCode).toBe(404);

    // Another person logs in on the same phone: the device moves.
    await api(b.id, "PUT", "/me/push-devices", { body: { token, platform: "android" } });
    const listA = await api(a.id, "GET", "/me/push-devices");
    expect(listA.json<{ items: unknown[] }>().items).toEqual([]);
    const listB = await api(b.id, "GET", "/me/push-devices");
    expect(listB.json<{ items: { id: string }[] }>().items.map((d) => d.id)).toEqual([device.id]);

    const removed = await api(b.id, "DELETE", `/me/push-devices/${device.id}`);
    expect(removed.statusCode).toBe(204);
    expect((await api(b.id, "GET", "/me/push-devices")).json<{ items: unknown[] }>().items).toEqual(
      [],
    );
  });

  it("the server announces push only with a push provider", async () => {
    const meta = await api(null, "GET", "/meta/client");
    expect(meta.json<{ features: string[] }>().features).toContain("notifications.push");
  });
});

describe("unsubscribe", () => {
  const accountOf = async (personId: string) =>
    (
      await t.query<{ id: string; notification_settings: Record<string, unknown> }>(
        "admin",
        "SELECT id, notification_settings FROM accounts WHERE person_id = $1",
        [personId],
      )
    ).rows[0]!;

  it("turns a category's email off from the page and from a mail client's one-click", async () => {
    const person = await buildPerson(s);
    const account = await accountOf(person.id);
    const page = await api(null, "POST", "/notifications/unsubscribe", {
      body: { token: unsubscribeToken(KEY, account.id, "events") },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ category: "events" });

    const oneClick = await api(
      null,
      "POST",
      `/notifications/unsubscribe?token=${encodeURIComponent(unsubscribeToken(KEY, account.id, "schedule"))}`,
      {
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
    );
    expect(oneClick.statusCode).toBe(200);
    expect((await accountOf(person.id)).notification_settings).toEqual({
      categories: { events: { email: "never" }, schedule: { email: "never" } },
    });
    const settings = await api(person.id, "GET", "/me/notification-settings");
    expect(
      settings
        .json<{ categories: { category: string; email: string }[] }>()
        .categories.find((c) => c.category === "events"),
    ).toMatchObject({ email: "never" });
    const { rows } = await t.query(
      "admin",
      "SELECT 1 FROM audit.events WHERE action = 'notifications.unsubscribed' AND resource_id = $1",
      [account.id],
    );
    expect(rows).toHaveLength(2);
  });

  it("refuses forged tokens and mandatory categories", async () => {
    const person = await buildPerson(s);
    const account = await accountOf(person.id);
    const forged = await api(null, "POST", "/notifications/unsubscribe", {
      body: {
        token: unsubscribeToken("another-key-another-key-another-key-42", account.id, "events"),
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(detail(forged)).toBe("unsubscribe_token_invalid");
    const missing = await api(null, "POST", "/notifications/unsubscribe", { body: {} });
    expect(missing.statusCode).toBe(400);
    const mandatory = await api(null, "POST", "/notifications/unsubscribe", {
      body: { token: unsubscribeToken(KEY, account.id, "account") },
    });
    expect(detail(mandatory)).toBe("notification_mandatory");
    expect((await accountOf(person.id)).notification_settings).toEqual({});
  });
});
