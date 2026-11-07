// SPDX-License-Identifier: AGPL-3.0-only
// The profile view log in the worker (P1.12): someone who left a club is no
// longer named in its log (as viewer or viewed) and the anonymisation ledger
// records it; the ledger replay after a restore applies it again; old rows
// and ledger entries go; changes of protection are told to the club's
// managers (never naming the person) and to the other full guardians.

import { outbox } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { notificationsHandler } from "../notifications/handler.ts";
import { anonymizeIfLeft, runProfileViewsRetention } from "./profile-views.ts";

let t: TestDatabase;
const club = uuidv7();
const manager = uuidv7();
const member = uuidv7();
const leaver = uuidv7();
const parent = uuidv7();
const otherParent = uuidv7();
const child = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  const s = await t.connect("admin");
  try {
    await s.query("BEGIN");
    for (const [id, name] of [
      [manager, "Manager"],
      [member, "Member"],
      [leaver, "Leaver"],
      [parent, "Parent"],
      [otherParent, "Other"],
      [child, "Child"],
    ] as const) {
      await s.query("INSERT INTO people (id, given_name, family_name) VALUES ($1, $2, 'Person')", [
        id,
        name,
      ]);
    }
    for (const id of [manager, parent, otherParent]) {
      await s.query(
        "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, $2, now())",
        [id, `${id}@example.test`],
      );
    }
    await s.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Views IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `views-${club.slice(-8)}`],
    );
    await s.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [club, manager],
    );
    for (const id of [member, child]) {
      await s.query(
        "INSERT INTO club_memberships (club_id, person_id, status, membership_type) VALUES ($1, $2, 'active', 'active')",
        [club, id],
      );
    }
    for (const g of [parent, otherParent]) {
      await s.query(
        `INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights, status)
         VALUES ($1, $2, 'parent', '{view_schedule,act_on_behalf}', 'active')`,
        [g, child],
      );
    }
    await s.query("COMMIT");
  } finally {
    await s.end();
  }
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

async function view(viewer: string, viewed: string, monthsAgo = 0): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    "admin",
    `INSERT INTO profile_views (club_id, viewed_person_id, viewer_person_id, viewer_kind, surface,
       protected, day, first_viewed_at, last_viewed_at)
     VALUES ($1, $2, $3, 'person', 'profile', true, current_date - ($4::int * 30),
       now() - make_interval(months => $4), now() - make_interval(months => $4))
     RETURNING id`,
    [club, viewed, viewer, monthsAgo],
  );
  return rows[0]!.id;
}

const named = async (id: string) =>
  (
    await t.query<{ viewer: string | null; viewed: string | null; anonymized: boolean }>(
      "admin",
      `SELECT viewer_person_id AS viewer, viewed_person_id AS viewed,
         anonymized_at IS NOT NULL AS anonymized FROM profile_views WHERE id = $1`,
      [id],
    )
  ).rows[0];

describe("the profile view log", () => {
  it("stops naming someone who left the club, and the replay applies it again", async () => {
    const byLeaver = await view(leaver, member);
    const ofLeaver = await view(member, leaver);
    // Still a member: nothing changes.
    expect(await anonymizeIfLeft(t.db, club, member)).toBe(0);
    expect(await anonymizeIfLeft(t.db, club, leaver)).toBe(2);
    expect(await named(byLeaver)).toEqual({ viewer: null, viewed: member, anonymized: true });
    expect(await named(ofLeaver)).toEqual({ viewer: member, viewed: null, anonymized: true });
    const { rows: ledger } = await t.query<{ club_id: string }>(
      "admin",
      "SELECT club_id FROM privacy.anonymization_ledger WHERE person_id = $1",
      [leaver],
    );
    expect(ledger).toEqual([{ club_id: club }]);

    // "After a restore": the row names the leaver again; the replay fixes it.
    await t.query(
      "admin",
      "UPDATE profile_views SET viewer_person_id = $1, anonymized_at = NULL WHERE id = $2",
      [leaver, byLeaver],
    );
    await t.query("admin", "DELETE FROM privacy.anonymization_ledger WHERE person_id = $1", [
      leaver,
    ]);
    const external = [
      {
        kind: "anonymization",
        person_id: leaver,
        club_id: club,
        scope: "profile_views",
        erased_at: new Date().toISOString(),
        reason: "profile_views",
      },
    ];
    await t.query("admin", "SELECT * FROM privacy.replay_deletion_ledger($1::jsonb)", [
      JSON.stringify(external),
    ]);
    expect(await named(byLeaver)).toMatchObject({ viewer: null, anonymized: true });
    const { rows: deletions } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM privacy.deletion_ledger WHERE person_id = $1",
      [leaver],
    );
    expect(deletions[0]!.n).toBe(0);
  });

  it("deletes rows after 24 months and ledger entries after 13; catches up on leavers", async () => {
    const old = await view(manager, member, 25);
    const leaver2 = uuidv7();
    await t.query(
      "admin",
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'L', 'Two')",
      [leaver2],
    );
    const missed = await view(leaver2, member);
    await t.query(
      "admin",
      "INSERT INTO privacy.anonymization_ledger (person_id, club_id, scope, anonymized_at) VALUES ($1, $2, 'profile_views', now() - interval '14 months')",
      [uuidv7(), club],
    );
    const result = await runProfileViewsRetention(t.db);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.ledgerDeleted).toBe(1);
    expect(result.anonymized).toBeGreaterThanOrEqual(1);
    expect(await named(old)).toBeUndefined();
    expect(await named(missed)).toMatchObject({ viewer: null, anonymized: true });
  });
});

describe("protection notices", () => {
  it("tells the club's managers without naming the person, and the other guardian on removal", async () => {
    const handler = notificationsHandler({
      channels: { email: true, push: false },
      mail: { webUrl: "https://clubadmin.test", invitationTokenKey: undefined },
    });
    const events = await t.db.withSystem("test", {}, async (tx) => [
      await outbox.publish(tx, "person.protection.changed", {
        personId: member,
        clubId: club,
        enabled: true,
        scope: "club",
        byPersonId: uuidv7(),
      }),
      await outbox.publish(tx, "person.protection.changed", {
        personId: child,
        enabled: false,
        scope: "global",
        byPersonId: parent,
      }),
    ]);
    for (const id of events) await outbox.dispatch(t.db, id, [handler]);
    const notices = async (personId: string) =>
      (
        await t.query<{ type: string; about: string[]; params: Record<string, unknown> }>(
          "admin",
          "SELECT type, about_person_ids AS about, params FROM notifications WHERE recipient_person_id = $1 ORDER BY created_at",
          [personId],
        )
      ).rows;
    const toManager = await notices(manager);
    expect(toManager.map((n) => [n.type, n.params.change])).toEqual([
      ["member.protection.changed", "on"],
      ["member.protection.changed", "off"],
    ]);
    expect(toManager.every((n) => n.about.length === 0)).toBe(true);
    expect((await notices(otherParent)).map((n) => n.type)).toEqual(["family.protection.removed"]);
    expect(await notices(parent)).toEqual([]);
    // Redelivery creates nothing new.
    for (const id of events) await outbox.dispatch(t.db, id, [handler]);
    expect(await notices(manager)).toHaveLength(2);
  });
});
