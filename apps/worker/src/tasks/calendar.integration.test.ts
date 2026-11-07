// SPDX-License-Identifier: AGPL-3.0-only
// calendar:retention (P1.11) against a test database: feeds unused for a
// year are revoked and their owner told (calendar.feed.revoked), revoked
// feeds go 30 days later, and feeds in use or removed by their owner stay
// or are not announced.

import { outbox } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notificationsHandler } from "../notifications/handler.ts";
import { runCalendarRetention } from "./calendar.ts";

let t: TestDatabase;
const owner = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  await t.query(
    "admin",
    "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'Feed', 'Owner')",
    [owner],
  );
  // Notices go to people with a login.
  await t.query(
    "admin",
    "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, 'feed-owner@example.test', now())",
    [owner],
  );
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

async function feed(columns: {
  createdAt?: string;
  lastFetchedAt?: string | null;
  revokedAt?: string | null;
  reason?: string | null;
}): Promise<string> {
  const id = uuidv7();
  await t.query(
    "admin",
    `INSERT INTO calendar_feeds (id, person_id, scope, token_hash, created_at, last_fetched_at, revoked_at, revoked_reason)
     VALUES ($1, $2, 'my_schedule', $3, now() - $4::interval, now() - $5::interval, now() - $6::interval, $7)`,
    [
      id,
      owner,
      `hash-${id}`,
      columns.createdAt ?? "1 day",
      columns.lastFetchedAt ?? null,
      columns.revokedAt ?? null,
      columns.reason ?? null,
    ],
  );
  return id;
}

describe("calendar:retention", () => {
  it("revokes unused feeds (owner told), deletes long-revoked ones, keeps the rest", async () => {
    const unused = await feed({ createdAt: "14 months", lastFetchedAt: "13 months" });
    const neverFetched = await feed({ createdAt: "13 months" });
    const inUse = await feed({ createdAt: "14 months", lastFetchedAt: "2 days" });
    const fresh = await feed({});
    const oldRevoked = await feed({ revokedAt: "40 days", reason: "owner" });
    const recentRevoked = await feed({ revokedAt: "10 days", reason: "owner" });

    const result = await runCalendarRetention(t.db);
    expect(result).toEqual({ revoked: 2, deleted: 1 });
    const { rows } = await t.query<{ id: string; revoked_reason: string | null }>(
      "admin",
      "SELECT id, revoked_reason FROM calendar_feeds",
    );
    const state = new Map(rows.map((r) => [r.id, r.revoked_reason]));
    expect(state.get(unused)).toBe("unused");
    expect(state.get(neverFetched)).toBe("unused");
    expect(state.get(inUse)).toBeNull();
    expect(state.get(fresh)).toBeNull();
    expect(state.has(oldRevoked)).toBe(false);
    expect(state.get(recentRevoked)).toBe("owner");
    const { rows: audit } = await t.query<{ resource_id: string }>(
      "admin",
      "SELECT resource_id FROM audit.events WHERE action = 'calendar_feed.revoked'",
    );
    expect(audit.map((a) => a.resource_id).sort()).toEqual([unused, neverFetched].sort());

    // The owner is told about system revocations only, with the reason as a code.
    const { rows: events } = await t.query<{ id: string }>(
      "admin",
      "SELECT id FROM outbox.events WHERE type = 'calendar.feed.revoked'",
    );
    const ownRemoval = await t.db.withSystem("test", {}, (tx) =>
      outbox.publish(tx, "calendar.feed.revoked", { feedId: recentRevoked, personId: owner }),
    );
    const handler = notificationsHandler({
      channels: { email: true, push: false },
      mail: { webUrl: "https://clubadmin.test", invitationTokenKey: undefined },
    });
    for (const id of [...events.map((e) => e.id), ownRemoval]) {
      await outbox.dispatch(t.db, id, [handler]);
    }
    const { rows: notices } = await t.query<{
      type: string;
      subject_id: string;
      params: { feedReason: string };
    }>(
      "admin",
      "SELECT type, subject_id, params FROM notifications WHERE recipient_person_id = $1 ORDER BY subject_id",
      [owner],
    );
    expect(notices.map((n) => [n.type, n.subject_id, n.params.feedReason])).toEqual(
      [unused, neverFetched].sort().map((id) => ["calendar.feed.revoked", id, "unused"]),
    );
  });
});
