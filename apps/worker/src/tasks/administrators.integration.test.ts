// SPDX-License-Identifier: AGPL-3.0-only
// administrators:daily and the administrators' notices (P1.15 A3) against a
// test database: an unconfirmed suspension expires (target and initiator
// told), a grace period's reminders reach the administrators and the chair
// once each, a confirmed suspension is told to the target, the other
// administrators and the chair, not to the one who confirmed it.

import { outbox } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notificationsHandler } from "../notifications/handler.ts";
import { runAdministratorsJob } from "./administrators.ts";

let t: TestDatabase;
const channels = { email: false, push: false };
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

/** A club with three administrators (a, b, c) and a chair, all with logins. */
async function club(options: { graceUntil?: string } = {}) {
  const ids = {
    club: uuidv7(),
    a: uuidv7(),
    b: uuidv7(),
    c: uuidv7(),
    chair: uuidv7(),
  };
  const s = await t.connect("admin");
  try {
    await s.query("BEGIN");
    for (const person of [ids.a, ids.b, ids.c, ids.chair]) {
      await s.query(
        "INSERT INTO people (id, given_name, family_name, birth_date) VALUES ($1, 'Admin', 'Person', '1980-01-01')",
        [person],
      );
      await s.query(
        "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, $2, now())",
        [person, `a-${person.slice(-12)}@example.test`],
      );
    }
    await s.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Admin IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [ids.club, `admin-${ids.club.slice(-8)}`],
    );
    for (const person of [ids.a, ids.b, ids.c]) {
      await s.query(
        "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
        [ids.club, person],
      );
    }
    await s.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'chair')",
      [ids.club, ids.chair],
    );
    await s.query("COMMIT");
  } finally {
    await s.end();
  }
  if (options.graceUntil) {
    await t.query("admin", "UPDATE clubs SET administrators_grace_until = $2 WHERE id = $1", [
      ids.club,
      options.graceUntil,
    ]);
  }
  return ids;
}

async function notices(clubId: string, type: string) {
  const { rows } = await t.query<{ recipient_person_id: string; dedupe_key: string }>(
    "admin",
    "SELECT recipient_person_id, dedupe_key FROM notifications WHERE club_id = $1 AND type = $2",
    [clubId, type],
  );
  return rows;
}

async function dispatchAll() {
  const { rows } = await t.query<{ id: string }>(
    "admin",
    "SELECT id FROM outbox.events WHERE status <> 'done' ORDER BY created_at, id",
  );
  for (const { id } of rows) {
    await outbox.dispatch(t.db, id, [
      notificationsHandler({
        channels,
        mail: { webUrl: "https://clubadmin.test", invitationTokenKey: undefined },
      }),
    ]);
  }
}

describe("administrators:daily", () => {
  it("expires an unconfirmed suspension and tells the target and the initiator", async () => {
    const ids = await club();
    const { rows } = await t.query<{ id: string }>(
      "admin",
      `INSERT INTO administrator_suspensions
         (club_id, target_person_id, requested_by_person_id, reason, expires_at, created_at)
       VALUES ($1, $2, $3, 'other', now() - interval '1 hour', now() - interval '73 hours')
       RETURNING id`,
      [ids.club, ids.c, ids.a],
    );
    const result = await runAdministratorsJob(t.db, { channels });
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const { rows: status } = await t.query<{ status: string }>(
      "admin",
      "SELECT status FROM administrator_suspensions WHERE id = $1",
      [rows[0]!.id],
    );
    expect(status[0]?.status).toBe("expired");
    await dispatchAll();
    expect(
      (await notices(ids.club, "administrator.suspension.closed"))
        .map((n) => n.recipient_person_id)
        .sort(),
    ).toEqual([ids.a, ids.c].sort());
  });

  it("reminds after 14 and 25 days once each, and tells when the club needs administrators", async () => {
    // One administrator: the other two and the chair's role are ended for this test.
    const ids = await club();
    await t.query(
      "admin",
      `UPDATE clubs SET administrators_grace_until = now() + interval '30 days' WHERE id = $1;`,
      [ids.club],
    );
    await t.query(
      "admin",
      "UPDATE club_role_assignments SET valid_to = now() WHERE club_id = $1 AND person_id = ANY($2::uuid[])",
      [ids.club, [ids.b, ids.c]],
    );
    const now = Date.now();
    // Day 3: nothing; day 15: the first reminder (twice the same day: once).
    await runAdministratorsJob(t.db, { channels, now: new Date(now + 3 * DAY) });
    expect(await notices(ids.club, "club.administrators.grace_reminder")).toEqual([]);
    await runAdministratorsJob(t.db, { channels, now: new Date(now + 15 * DAY) });
    await runAdministratorsJob(t.db, { channels, now: new Date(now + 15 * DAY + 3_600_000) });
    const first = await notices(ids.club, "club.administrators.grace_reminder");
    expect(first.map((n) => n.recipient_person_id).sort()).toEqual([ids.a, ids.chair].sort());
    await runAdministratorsJob(t.db, { channels, now: new Date(now + 26 * DAY) });
    expect(await notices(ids.club, "club.administrators.grace_reminder")).toHaveLength(4);
    await runAdministratorsJob(t.db, { channels, now: new Date(now + 31 * DAY) });
    expect(await notices(ids.club, "club.administrators.needed")).toHaveLength(2);
  });

  it("ends the grace period of a club that has two administrators", async () => {
    const ids = await club({ graceUntil: new Date(Date.now() + 10 * DAY).toISOString() });
    await runAdministratorsJob(t.db, { channels });
    const { rows } = await t.query<{ grace: string | null }>(
      "admin",
      "SELECT administrators_grace_until AS grace FROM clubs WHERE id = $1",
      [ids.club],
    );
    expect(rows[0]?.grace).toBeNull();
  });
});

describe("administrator notices", () => {
  it("a confirmed suspension: the target, the other administrators and the chair", async () => {
    const ids = await club();
    const { rows } = await t.query<{ id: string }>(
      "admin",
      `INSERT INTO administrator_suspensions
         (club_id, target_person_id, requested_by_person_id, confirmed_by_person_id, reason,
          status, expires_at, decided_at)
       VALUES ($1, $2, $3, $4, 'compromised', 'confirmed', now() + interval '1 day', now())
       RETURNING id`,
      [ids.club, ids.c, ids.a, ids.b],
    );
    await t.db.withSystem("test", { clubId: ids.club }, (tx) =>
      outbox.publish(tx, "administrator.suspended", {
        clubId: ids.club,
        suspensionId: rows[0]!.id,
        personId: ids.c,
      }),
    );
    await dispatchAll();
    expect(
      (await notices(ids.club, "administrator.suspended")).map((n) => n.recipient_person_id).sort(),
    ).toEqual([ids.a, ids.c, ids.chair].sort());
  });
});
