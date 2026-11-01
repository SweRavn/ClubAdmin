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

/** Free text and consents erasure covers since P1.8a, for a person in the test club. */
async function addFreeText(id: string, email: string) {
  const other = uuidv7();
  await t.query(
    "admin",
    "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'Parent', 'Other')",
    [other],
  );
  await t.query(
    "admin",
    `INSERT INTO join_requests (club_id, person_id, requested_by_person_id, status, message, decision_message)
     VALUES ($1, $2, $2, 'rejected', 'My son has asthma', 'Sorry, the team is full')`,
    [club, id],
  );
  await t.query(
    "admin",
    `INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights, consent_note, ended_reason)
     VALUES ($1, $2, 'parent', '{view_schedule}', 'Paper form in the office', 'Custody dispute')`,
    [other, id],
  );
  await t.query(
    "admin",
    `INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id, source, club_note)
     VALUES ($1, $2, 'photo_publication', 'default:1', $2, 'club_record', 'Signed by grandmother')`,
    [club, id],
  );
  await t.query(
    "admin",
    `INSERT INTO invitations (club_id, kind, email, token_hash, expires_at, created_by_person_id)
     VALUES ($1, 'email', $2, $3, now() + interval '7 days', $4)`,
    [club, email, `hash-${id}`, other],
  );
}

describe("privacy.erase_person (P1.8a)", () => {
  it("clears join request, guardianship and consent notes, invitations to the address, and open consents", async () => {
    const id = await createPerson("Fredrik");
    const email = (
      await t.query<{ email: string }>("admin", "SELECT email FROM accounts WHERE person_id = $1", [
        id,
      ])
    ).rows[0]!.email;
    await addFreeText(id, email);
    await t.query("retention", "SELECT privacy.erase_person($1, 'account_deleted')", [id]);

    const rows = await t.query(
      "admin",
      `SELECT
         (SELECT row(message, decision_message)::text FROM join_requests WHERE person_id = $1) AS request,
         (SELECT row(consent_note, ended_reason)::text FROM guardianships WHERE ward_person_id = $1) AS guardianship,
         (SELECT row(revoked_reason, club_note)::text FROM consents WHERE person_id = $1) AS consent,
         (SELECT count(*)::int FROM invitations WHERE email = $2) AS invitations`,
      [id, email],
    );
    expect(rows.rows[0]).toEqual({
      request: "(,)",
      guardianship: "(,)",
      consent: "(erased,)",
      invitations: 0,
    });
    const history = await t.query<{ v: unknown }>(
      "admin",
      `SELECT coalesce(old_values, '{}') || coalesce(new_values, '{}') AS v FROM history.record_changes
       WHERE table_name IN ('public.join_requests', 'public.guardianships', 'public.consents', 'public.invitations')`,
    );
    const text = JSON.stringify(history.rows);
    for (const value of ["asthma", "team is full", "Paper form", "Custody", "grandmother", email]) {
      expect(text).not.toContain(value);
    }
    expect(await unerased()).not.toContain(id);
  });

  it("the ledger replay clears them again after a restore", async () => {
    const id = await createPerson("Gunnel");
    await addFreeText(id, `gunnel-${id}@example.test`);
    await t.query("retention", "SELECT privacy.erase_person($1, 'account_deleted')", [id]);
    // The restore brings back the request's message and an open consent.
    await t.query(
      "admin",
      "UPDATE join_requests SET message = 'Restored text' WHERE person_id = $1",
      [id],
    );
    await t.query(
      "admin",
      "UPDATE consents SET revoked_at = NULL, revoked_reason = NULL WHERE person_id = $1",
      [id],
    );
    expect(await unerased()).toContain(id);
    await t.query("retention", "SELECT * FROM privacy.replay_deletion_ledger()");
    expect(await unerased()).toEqual([]);
  });
});

/** A former member: a membership that ended `monthsAgo` months ago, with club data to purge. */
async function formerMember(monthsAgo: number, withAccount = false): Promise<string> {
  const id = uuidv7();
  await t.query(
    "admin",
    "INSERT INTO people (id, given_name, family_name, phone) VALUES ($1, 'Former', 'Member', '+4670111')",
    [id],
  );
  if (withAccount) {
    await t.query(
      "admin",
      "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, $2, now())",
      [id, `former-${id}@example.test`],
    );
  }
  await t.query(
    "admin",
    `INSERT INTO club_profiles (club_id, person_id, shared_fields, emergency_contacts, notes)
     VALUES ($1, $2, '{phone}', '[{"name":"Mamma","phone":"+4670222"}]', 'Club note about knees')`,
    [club, id],
  );
  await t.query(
    "admin",
    `INSERT INTO club_memberships (club_id, person_id, status, valid_from, valid_to)
     VALUES ($1, $2, 'left', now() - make_interval(months => $3 + 24), now() - make_interval(months => $3))`,
    [club, id, monthsAgo],
  );
  await t.query(
    "admin",
    `INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id, revoked_at, revoked_reason)
     VALUES ($1, $2, 'photo_publication', 'default:1', $2, now() - make_interval(months => $3), 'left_club')`,
    [club, id, monthsAgo],
  );
  await t.query(
    "admin",
    `INSERT INTO join_requests (club_id, person_id, requested_by_person_id, status, message)
     VALUES ($1, $2, $2, 'approved', 'Please let me join, I play left back')`,
    [club, id],
  );
  return id;
}

const purge = (person: string, now = false) =>
  t
    .query<{ purged: boolean }>(
      "retention",
      "SELECT privacy.purge_former_member($1, $2, $3) AS purged",
      [club, person, now],
    )
    .then((r) => r.rows[0]?.purged);

describe("privacy.purge_former_member", () => {
  it("keeps the minimised facts and clears contact data, notes, consents and free text after the period", async () => {
    const id = await formerMember(30);
    expect(await purge(id)).toBe(true);
    const profile = await t.query(
      "admin",
      `SELECT shared_fields, emergency_contacts, notes, member_number IS NOT NULL AS numbered,
              club_data_purged_at IS NOT NULL AS purged
       FROM club_profiles WHERE person_id = $1`,
      [id],
    );
    expect(profile.rows[0]).toEqual({
      shared_fields: [],
      emergency_contacts: [],
      notes: null,
      numbered: true,
      purged: true,
    });
    const rest = await t.query(
      "admin",
      `SELECT (SELECT count(*)::int FROM consents WHERE person_id = $1) AS consents,
              (SELECT message FROM join_requests WHERE person_id = $1) AS message,
              (SELECT count(*)::int FROM club_memberships WHERE person_id = $1) AS memberships`,
      [id],
    );
    expect(rest.rows[0]).toEqual({ consents: 0, message: null, memberships: 1 });
    const history = await t.query(
      "admin",
      `SELECT old_values, new_values FROM history.record_changes
       WHERE record_id IN (SELECT id FROM club_profiles WHERE person_id = $1)
          OR record_id IN (SELECT id FROM join_requests WHERE person_id = $1)`,
      [id],
    );
    const text = JSON.stringify(history.rows);
    for (const value of ["knees", "Mamma", "left back"]) expect(text).not.toContain(value);
    const audit = await t.query(
      "admin",
      "SELECT action, club_id FROM audit.events WHERE resource_id = $1",
      [id],
    );
    expect(audit.rows).toEqual([{ action: "person.club_data.purged", club_id: club }]);
    // Idempotent.
    expect(await purge(id)).toBe(false);
  });

  it("waits for the club's period unless the person chose to remove the data now", async () => {
    const id = await formerMember(3);
    expect(await purge(id)).toBe(false);
    expect(await purge(id, true)).toBe(true);
  });

  it("never purges someone with an open relationship to the club", async () => {
    const id = await formerMember(30);
    await t.query(
      "admin",
      "INSERT INTO join_requests (club_id, person_id, requested_by_person_id) VALUES ($1, $2, $2)",
      [club, id],
    );
    expect(await purge(id)).toBe(false);
  });

  it("cannot be run by the app role", async () => {
    const id = await formerMember(30);
    await expect(
      t.query("app", "SELECT privacy.purge_former_member($1, $2)", [club, id]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("orphaned people", () => {
  const mark = (person: string) =>
    t
      .query<{ since: Date | null }>("retention", "SELECT privacy.mark_orphan($1) AS since", [
        person,
      ])
      .then((r) => r.rows[0]?.since ?? null);

  it("a purged former member without login becomes an orphan; a guardianship or a login keeps them", async () => {
    const orphan = await formerMember(30);
    expect(await mark(orphan)).toBeNull();
    await purge(orphan);
    expect(await mark(orphan)).toBeInstanceOf(Date);

    const withLogin = await formerMember(30, true);
    await purge(withLogin);
    expect(await mark(withLogin)).toBeNull();

    const ward = await formerMember(30);
    await purge(ward);
    const guardian = uuidv7();
    await t.query(
      "admin",
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'Guardian', 'Present')",
      [guardian],
    );
    await t.query(
      "admin",
      "INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights) VALUES ($1, $2, 'parent', '{view_schedule}')",
      [guardian, ward],
    );
    expect(await mark(ward)).toBeNull();

    // A new relationship clears the mark.
    await t.query(
      "admin",
      "INSERT INTO club_memberships (club_id, person_id, status) VALUES ($1, $2, 'active')",
      [club, orphan],
    );
    expect(await mark(orphan)).toBeNull();
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
