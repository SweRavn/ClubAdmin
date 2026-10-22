// SPDX-License-Identifier: AGPL-3.0-only
// GDPR erasure core and the deletion-ledger replay after a restore
// (migrations/0005_backup_ops.sql, docs/operations/backup-restore.md).

import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let t: TestDatabase;
const club = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  // A club needs an active club manager when its transaction commits.
  const session = await t.connect("admin");
  try {
    const manager = uuidv7();
    await session.query("BEGIN");
    await session.query(
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'Manager', 'Person')",
      [manager],
    );
    await session.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Privacy IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `privacy-${club.slice(-8)}`],
    );
    await session.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [club, manager],
    );
    await session.query("COMMIT");
  } finally {
    await session.end();
  }
});
afterAll(async () => {
  await t?.drop();
});

/** A person with every kind of personal data the erasure covers, written through the history trigger. */
async function createPerson(given: string): Promise<string> {
  const id = uuidv7();
  await t.query(
    "admin",
    `INSERT INTO people (id, given_name, family_name, birth_date, phone, address,
                         personal_identity_number, personal_identity_number_hash)
     VALUES ($1, $2, 'Lindqvist', '2011-05-17', '+46701234567',
             '{"street":"Storgatan 1","postalCode":"11122","city":"Stockholm","country":"SE"}',
             'ciphertext', 'blind-index')`,
    [id, given],
  );
  await t.query(
    "admin",
    `INSERT INTO accounts (person_id, email, email_verified_at, idp_subject)
     VALUES ($1, $2, now(), $3)`,
    [id, `${given.toLowerCase()}-${id.slice(-6)}@example.test`, `sub-${id}`],
  );
  await t.query(
    "admin",
    `INSERT INTO club_profiles (club_id, person_id, emergency_contacts, notes)
     VALUES ($1, $2, '[{"name":"Parent Lindqvist","phone":"+46700000000"}]', 'Allergic to nuts')`,
    [club, id],
  );
  await t.query("admin", "UPDATE people SET phone = '+46709999999' WHERE id = $1", [id]);
  return id;
}

const personRow = (id: string) =>
  t
    .query<Record<string, unknown>>("admin", "SELECT * FROM people WHERE id = $1", [id])
    .then((r) => r.rows[0]);

const unerased = () =>
  t
    .query<{ person_id: string }>("admin", "SELECT person_id FROM privacy.unerased_people()")
    .then((r) => r.rows.map((row) => row.person_id));

describe("privacy.erase_person", () => {
  it("anonymises the person, records the ledger and scrubs the history (as the retention role)", async () => {
    const id = await createPerson("Annika");
    const result = await t.query<{ erase_person: boolean }>(
      "retention",
      "SELECT privacy.erase_person($1, 'account_deleted')",
      [id],
    );
    expect(result.rows[0]?.erase_person).toBe(true);

    expect(await personRow(id)).toMatchObject({
      given_name: "",
      family_name: "",
      birth_date: expect.any(Date) as unknown,
      phone: null,
      address: null,
      personal_identity_number: null,
      personal_identity_number_hash: null,
      anonymized_at: expect.any(Date) as unknown,
    });
    expect(((await personRow(id))?.birth_date as Date).getMonth()).toBe(0);

    const account = await t.query(
      "admin",
      "SELECT email, idp_subject FROM accounts WHERE person_id = $1",
      [id],
    );
    expect(account.rows[0]).toEqual({ email: `erased-${id}@erased.invalid`, idp_subject: null });
    const profile = await t.query(
      "admin",
      "SELECT emergency_contacts, notes FROM club_profiles WHERE person_id = $1",
      [id],
    );
    expect(profile.rows[0]).toEqual({ emergency_contacts: [], notes: null });

    const ledger = await t.query(
      "admin",
      "SELECT reason FROM privacy.deletion_ledger WHERE person_id = $1",
      [id],
    );
    expect(ledger.rows).toEqual([{ reason: "account_deleted" }]);

    // No personal value survives in the record history, but the changes are still there.
    const history = await t.query<{ old_values: unknown; new_values: unknown; operation: string }>(
      "admin",
      `SELECT h.old_values, h.new_values, h.operation FROM history.record_changes h
       WHERE h.record_id = $1
          OR h.record_id IN (SELECT id FROM accounts WHERE person_id = $1)
          OR h.record_id IN (SELECT id FROM club_profiles WHERE person_id = $1)`,
      [id],
    );
    expect(history.rows.length).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify(history.rows);
    for (const value of [
      "Annika",
      "Lindqvist",
      "+4670",
      "Storgatan",
      "ciphertext",
      "nuts",
      "example.test",
      "sub-",
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("[erased]");

    const audit = await t.query(
      "admin",
      "SELECT action, actor_kind FROM audit.events WHERE resource_id = $1",
      [id],
    );
    expect(audit.rows).toEqual([{ action: "person.erased", actor_kind: "system_job" }]);
    expect(await unerased()).not.toContain(id);
  });

  it("is idempotent", async () => {
    const id = await createPerson("Bertil");
    await t.query("retention", "SELECT privacy.erase_person($1, 'account_deleted')", [id]);
    const again = await t.query<{ erase_person: boolean }>(
      "retention",
      "SELECT privacy.erase_person($1, 'account_deleted')",
      [id],
    );
    expect(again.rows[0]?.erase_person).toBe(false);
  });

  it("refuses an unknown person unless replaying", async () => {
    await expect(
      t.query("retention", "SELECT privacy.erase_person($1, 'account_deleted')", [uuidv7()]),
    ).rejects.toThrow(/does not exist/);
    const replay = await t.query<{ erase_person: boolean }>(
      "retention",
      "SELECT privacy.erase_person($1, 'account_deleted', true)",
      [uuidv7()],
    );
    expect(replay.rows[0]?.erase_person).toBe(false);
  });

  it("cannot be run by the app role", async () => {
    const id = await createPerson("Cecilia");
    await expect(
      t.query("app", "SELECT privacy.erase_person($1, 'account_deleted')", [id]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("privacy.replay_deletion_ledger", () => {
  it("erases people again whose data came back with a restore, and merges external entries", async () => {
    // Erased before the backup: the ledger entry is in the restored database too.
    const restored = await createPerson("Doris");
    await t.query("retention", "SELECT privacy.erase_person($1, 'account_deleted')", [restored]);
    // A restore brings the person's data back (imitated: the values return).
    await t.query(
      "admin",
      "UPDATE people SET given_name = 'Doris', family_name = 'Lindqvist', anonymized_at = NULL WHERE id = $1",
      [restored],
    );
    // Erased after the backup: only the ledger export (outside the backup) knows.
    const external = await createPerson("Egon");
    const notRestored = uuidv7();
    expect(await unerased()).toEqual(expect.arrayContaining([restored]));

    const replay = await t.query<{ ledger_entries: number; added: number; erased: number }>(
      "retention",
      "SELECT * FROM privacy.replay_deletion_ledger($1)",
      [
        JSON.stringify([
          { person_id: external, erased_at: "2026-01-01T00:00:00Z", reason: "account_deleted" },
          // A person created after the restore point does not exist here.
          { person_id: notRestored, reason: "account_deleted" },
          { person_id: restored, reason: "account_deleted" },
        ]),
      ],
    );
    expect(replay.rows[0]).toMatchObject({ added: 2, erased: 2 });
    expect(await personRow(restored)).toMatchObject({
      given_name: "",
      anonymized_at: expect.any(Date) as unknown,
    });
    expect(await personRow(external)).toMatchObject({ given_name: "", family_name: "" });
    expect(await unerased()).toEqual([]);

    const again = await t.query<{ erased: number }>(
      "retention",
      "SELECT * FROM privacy.replay_deletion_ledger()",
    );
    expect(again.rows[0]?.erased).toBe(0);
  });
});

describe("ops.key_table_counts", () => {
  it("counts the key tables", async () => {
    const result = await t.query<{ counts: Record<string, number> }>(
      "admin",
      "SELECT ops.key_table_counts() AS counts",
    );
    expect(result.rows[0]?.counts).toMatchObject({
      "public.clubs": 1,
      "public.people": expect.any(Number) as unknown,
      "privacy.deletion_ledger": expect.any(Number) as unknown,
    });
  });
});
