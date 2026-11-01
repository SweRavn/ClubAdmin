// SPDX-License-Identifier: AGPL-3.0-only
// The privacy jobs (P1.8a) against a test database, as clubadmin_retention:
// former members purged after their club's period, orphaned people erased
// after the installation's period, the audit log by age, board decisions
// taking effect, and a protected person's consents ending.

import { createDatabase, type Database } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyDueDecisions,
  revokeInapplicableConsents,
  runAuditRetention,
  runPrivacyRetention,
} from "./privacy.ts";

let t: TestDatabase;
let retention: Database;
const club = uuidv7();
const manager = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  retention = createDatabase({ url: t.url("retention"), max: 1 });
  const s = await t.connect("admin");
  try {
    await s.query("BEGIN");
    await s.query(
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'Manager', 'Person')",
      [manager],
    );
    await s.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Privacy IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `privacy-${club.slice(-8)}`],
    );
    await s.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [club, manager],
    );
    await s.query("COMMIT");
  } finally {
    await s.end();
  }
}, 120_000);
afterAll(async () => {
  await retention?.close();
  await t?.drop();
});

/** A former member without login whose membership ended `monthsAgo` months ago. */
async function formerMember(monthsAgo: number): Promise<string> {
  const id = uuidv7();
  await t.query(
    "admin",
    "INSERT INTO people (id, given_name, family_name, phone) VALUES ($1, 'Ola', 'Former', '+4670')",
    [id],
  );
  await t.query(
    "admin",
    `INSERT INTO club_profiles (club_id, person_id, shared_fields, notes)
     VALUES ($1, $2, '{phone}', 'Note')`,
    [club, id],
  );
  await t.query(
    "admin",
    `INSERT INTO club_memberships (club_id, person_id, status, valid_from, valid_to)
     VALUES ($1, $2, 'left', now() - interval '5 years', now() - make_interval(months => $3))`,
    [club, id, monthsAgo],
  );
  return id;
}

const one = <T>(rows: T[]) => rows[0]!;

describe("privacy:retention", () => {
  it("purges former members past the club's period, then erases them once orphaned long enough", async () => {
    const old = await formerMember(30);
    const recent = await formerMember(3);
    const first = await runPrivacyRetention(retention, { orphanRetentionMonths: 36 });
    expect(first).toMatchObject({ purged: 1, erased: 0 });
    const { rows } = await t.query<{ id: string; notes: string | null; orphaned: boolean }>(
      "admin",
      `SELECT p.person_id AS id, p.notes, pe.orphaned_since IS NOT NULL AS orphaned
       FROM club_profiles p JOIN people pe ON pe.id = p.person_id
       WHERE p.person_id IN ($1, $2) ORDER BY p.person_id = $1 DESC`,
      [old, recent],
    );
    expect(rows).toEqual([
      { id: old, notes: null, orphaned: true },
      { id: recent, notes: "Note", orphaned: false },
    ]);

    // Orphaned for 40 months: erased, and in the ledger.
    await t.query(
      "admin",
      "UPDATE people SET orphaned_since = now() - interval '40 months' WHERE id = $1",
      [old],
    );
    const second = await runPrivacyRetention(retention, { orphanRetentionMonths: 36 });
    expect(second.erased).toBe(1);
    const erased = await t.query<{ given_name: string; reason: string }>(
      "admin",
      `SELECT p.given_name, l.reason FROM people p
       JOIN privacy.deletion_ledger l ON l.person_id = p.id WHERE p.id = $1`,
      [old],
    );
    expect(one(erased.rows)).toEqual({ given_name: "", reason: "retention" });
  });
});

describe("audit:retention", () => {
  it("deletes audit events older than the installation's period", async () => {
    const id = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO audit.events (actor_kind, action, resource_type, resource_id, created_at)
       VALUES ('system_job', 'person.erased', 'person', $1, now() - interval '30 months')`,
      [id],
    );
    expect(await runAuditRetention(retention, 24)).toBeGreaterThanOrEqual(1);
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM audit.events WHERE resource_id = $1",
      [id],
    );
    expect(one(rows).n).toBe(0);
  });
});

describe("clubs:apply_decisions", () => {
  it("applies a board decision whose day has come and publishes the policy", async () => {
    const decision = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO club_setting_decisions (id, club_id, body, decided_on, reference, effective_from,
         settings, recorded_by_person_id)
       VALUES ($1, $2, 'board', current_date - 10, '§ 4', current_date - 1,
         '{"former_member_retention_months": 12}', $3)`,
      [decision, club, manager],
    );
    expect(await applyDueDecisions(t.db, retention)).toBe(1);
    const { rows } = await t.query<{ months: number; versions: number; events: number }>(
      "admin",
      `SELECT (SELECT former_member_retention_months FROM clubs WHERE id = $1) AS months,
              (SELECT count(*)::int FROM club_privacy_policies WHERE club_id = $1) AS versions,
              (SELECT count(*)::int FROM outbox.events WHERE type = 'club.privacy_policy.published'
                 AND payload ->> 'clubId' = $1::text) AS events`,
      [club],
    );
    expect(one(rows)).toEqual({ months: 12, versions: 2, events: 1 });
    expect(await applyDueDecisions(t.db, retention)).toBe(0);
  });
});

describe("privacy:protection_changed", () => {
  it("ends a protected person's photo and contact consents, not marketing", async () => {
    const id = uuidv7();
    await t.query(
      "admin",
      "INSERT INTO people (id, given_name, family_name, protected_identity) VALUES ($1, 'Nadia', 'P', true)",
      [id],
    );
    await t.query("admin", "INSERT INTO club_profiles (club_id, person_id) VALUES ($1, $2)", [
      club,
      id,
    ]);
    for (const purpose of ["photo_publication", "contacts_group", "marketing"]) {
      await t.query(
        "admin",
        `INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id)
         VALUES ($1, $2, $3, 'default:1', $2)`,
        [club, id, purpose],
      );
    }
    expect(await revokeInapplicableConsents(retention, id, null)).toBe(2);
    const { rows } = await t.query<{ purpose: string; revoked_reason: string | null }>(
      "admin",
      "SELECT purpose, revoked_reason FROM consents WHERE person_id = $1 ORDER BY purpose",
      [id],
    );
    expect(rows).toEqual([
      { purpose: "contacts_group", revoked_reason: "not_applicable" },
      { purpose: "marketing", revoked_reason: null },
      { purpose: "photo_publication", revoked_reason: "not_applicable" },
    ]);
  });
});
