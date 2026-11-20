// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@clubadmin/db";
import { emailChangeCode } from "@clubadmin/server-kit/invitations";
import { uuidv7 } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { historyOf, useCoreDatabase } from "../../testing/core.ts";
import { TEST_INVITATION_TOKEN_KEY } from "../../testing/services.ts";

const c = useCoreDatabase();

const yearsAgo = (years: number, days = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

describe("accounts", () => {
  it("rejects a duplicate email in another case, without echoing it", async () => {
    const anna = await buildPerson(c.s, { email: "anna.lindqvist@example.test" });
    expect(anna.email).toBe("anna.lindqvist@example.test");
    const id = uuidv7();
    await c.s.people.createSelf(actor(id), {
      givenName: "A",
      familyName: "B",
      birthDate: "1990-01-01",
    });
    const error = await c.s.accounts
      .createAccount(actor(id), {
        email: "  Anna.Lindqvist@EXAMPLE.test ",
        emailVerifiedAt: new Date(),
      })
      .catch((e: unknown) => e);
    expect(isDomainError(error, "email_taken")).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/lindqvist/i);
    expect(String((error as Error).message)).not.toMatch(/lindqvist/i);
    expect((error as Error).cause).toBeUndefined();
  });

  it("is unique case-insensitively in the database too", async () => {
    const p = await buildPerson(c.s, { email: null });
    const q = await buildPerson(c.s, { email: null });
    await c.t.query("admin", "ALTER TABLE accounts DROP CONSTRAINT accounts_email_normalised");
    try {
      await c.t.query(
        "admin",
        "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, 'Case@Example.test', now())",
        [p.id],
      );
      await expect(
        c.t.query(
          "admin",
          "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, 'case@example.TEST', now())",
          [q.id],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: "accounts_email_unique" });
    } finally {
      await c.t.query("admin", "DELETE FROM accounts WHERE person_id = $1", [p.id]);
      await c.t.query(
        "admin",
        "ALTER TABLE accounts ADD CONSTRAINT accounts_email_normalised CHECK (email = lower(btrim(email)))",
      );
    }
  });

  it("one account per person", async () => {
    const p = await buildPerson(c.s);
    await expect(
      c.s.accounts.createAccount(actor(p.id), {
        email: "second@example.test",
        emailVerifiedAt: new Date(),
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "account_exists"));
  });

  it("people never have an email column", async () => {
    const { rows } = await c.t.query<{ column_name: string }>(
      "admin",
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people'",
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => /mail/i.test(r.column_name))).toEqual([]);
  });

  it("changes the email to an unused address and notifies through the outbox", async () => {
    const p = await buildPerson(c.s);
    const other = await buildPerson(c.s);
    await expect(
      c.s.accounts.changeEmail(actor(p.id), other.email!.toUpperCase(), new Date()),
    ).rejects.toSatisfy((e) => isDomainError(e, "email_taken"));
    const changed = await c.s.accounts.changeEmail(
      actor(p.id),
      "New.Address@example.test",
      new Date(),
    );
    expect(changed.email).toBe("new.address@example.test");
    const { rows } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'account.email.changed' AND payload ->> 'personId' = $1",
      [p.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("changes the login email only with the code sent to the new address (P2.7d)", async () => {
    const p = await buildPerson(c.s);
    const old = p.email!;
    await expect(c.s.accounts.requestEmailChange(actor(p.id), old.toUpperCase())).rejects.toSatisfy(
      (e) => isDomainError(e, "email_unchanged"),
    );
    const pending = await c.s.accounts.requestEmailChange(actor(p.id), "Next@Example.test");
    expect(pending).toMatchObject({ email: old, pendingEmail: "next@example.test" });
    const { rows: events } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'account.email.change_requested' AND payload ->> 'personId' = $1",
      [p.id],
    );
    expect(events[0]?.n).toBe(1);
    const code = emailChangeCode(TEST_INVITATION_TOKEN_KEY, pending.pendingEmailId!);
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(c.s.accounts.confirmEmailChange(actor(p.id), wrong)).rejects.toSatisfy((e) =>
      isDomainError(e, "email_code_invalid"),
    );
    // The wrong attempt is counted (its transaction commits).
    const counted = await c.s.accounts.getOwnAccount(actor(p.id));
    expect(counted?.pendingEmailAttempts).toBe(1);
    const changed = await c.s.accounts.confirmEmailChange(actor(p.id), code);
    expect(changed).toMatchObject({ email: "next@example.test", pendingEmail: null });
    const { rows } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'account.email.changed' AND payload ->> 'personId' = $1",
      [p.id],
    );
    expect(rows[0]?.n).toBe(1);
    // The code works once.
    await expect(c.s.accounts.confirmEmailChange(actor(p.id), code)).rejects.toSatisfy((e) =>
      isDomainError(e, "email_code_expired"),
    );
  });

  it("drops an email change after too many wrong codes, and a new request replaces the code", async () => {
    const p = await buildPerson(c.s);
    const first = await c.s.accounts.requestEmailChange(actor(p.id), `a-${uuidv7()}@example.test`);
    const second = await c.s.accounts.requestEmailChange(actor(p.id), `b-${uuidv7()}@example.test`);
    const oldCode = emailChangeCode(TEST_INVITATION_TOKEN_KEY, first.pendingEmailId!);
    const newCode = emailChangeCode(TEST_INVITATION_TOKEN_KEY, second.pendingEmailId!);
    const wrong = ["000000", "111111", "222222", "333333", "444444", "555555"]
      .filter((x) => x !== newCode)
      .slice(0, 5);
    if (oldCode !== newCode) wrong[0] = oldCode;
    for (const [i, code] of wrong.entries()) {
      await expect(c.s.accounts.confirmEmailChange(actor(p.id), code)).rejects.toSatisfy((e) =>
        isDomainError(e, i < 4 ? "email_code_invalid" : "email_code_expired"),
      );
    }
    const account = await c.s.accounts.getOwnAccount(actor(p.id));
    expect(account).toMatchObject({ email: p.email, pendingEmail: null });
    await expect(c.s.accounts.confirmEmailChange(actor(p.id), newCode)).rejects.toSatisfy((e) =>
      isDomainError(e, "email_code_expired"),
    );
  });

  it("accounts are visible only to their own person", async () => {
    const p = await buildPerson(c.s);
    const q = await buildPerson(c.s);
    const seen = await c.t.db.withActor(actor(q.id), (tx) =>
      tx.execute(sql`SELECT id FROM accounts WHERE person_id = ${p.id}`),
    );
    expect(seen.rows).toEqual([]);
    expect(await c.s.accounts.getOwnAccount(actor(p.id))).toMatchObject({ email: p.email });
  });
});

describe("giving a child their own login", () => {
  it("links a new account to the existing person; memberships and history are unchanged", async () => {
    const club = await buildClub(c.s);
    const family = await buildFamily(c.s, { childBirthDate: yearsAgo(14), club });
    const child = family.child;
    const group = await c.s.groups.createGroup(club.ctx, { name: "P2012", kind: "team" });
    await c.s.memberships.addToGroup(club.ctx, group.id, child.id);

    const before = await c.s.memberships.myClubsAndGroups(actor(family.guardian.id), child.id);
    const { rows: historyBefore } = await c.t.query(
      "admin",
      "SELECT id, table_name, record_id, operation FROM history.record_changes WHERE table_name <> 'public.accounts' AND (record_id = $1::uuid OR new_values ->> 'person_id' = $1::text) ORDER BY id",
      [child.id],
    );

    const account = await c.s.accounts.linkAccount(actor(child.id), {
      email: "oskar.lindqvist@example.test",
      emailVerifiedAt: new Date(),
    });
    expect(account.personId).toBe(child.id);

    expect(await c.s.memberships.myClubsAndGroups(actor(child.id), child.id)).toEqual(before);
    const { rows: historyAfter } = await c.t.query(
      "admin",
      "SELECT id, table_name, record_id, operation FROM history.record_changes WHERE table_name <> 'public.accounts' AND (record_id = $1::uuid OR new_values ->> 'person_id' = $1::text) ORDER BY id",
      [child.id],
    );
    expect(historyAfter).toEqual(historyBefore);
    expect(await historyOf(c.t, "public.accounts", account.id)).toEqual([
      expect.objectContaining({ operation: "INSERT", actor_person_id: child.id }),
    ]);
    // Guardians keep their rights.
    expect(await c.s.guardianships.guardiansOf(actor(family.guardian.id), child.id)).toHaveLength(
      2,
    );
  });

  it("refuses before the country pack's own_account_min_age, and twice", async () => {
    const family = await buildFamily(c.s, { childBirthDate: yearsAgo(13, -1) }); // turns 13 tomorrow
    await expect(
      c.s.accounts.linkAccount(actor(family.child.id), {
        email: "kid@example.test",
        emailVerifiedAt: new Date(),
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "too_young_for_account"));

    const older = await buildFamily(c.s, { childBirthDate: yearsAgo(13) });
    await c.s.accounts.linkAccount(actor(older.child.id), {
      email: "teen@example.test",
      emailVerifiedAt: new Date(),
    });
    await expect(
      c.s.accounts.linkAccount(actor(older.child.id), {
        email: "teen2@example.test",
        emailVerifiedAt: new Date(),
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "account_exists"));
  });

  it("cannot take a guardian's email", async () => {
    const family = await buildFamily(c.s, { childBirthDate: yearsAgo(15) });
    await expect(
      c.s.accounts.linkAccount(actor(family.child.id), {
        email: family.guardian.email!,
        emailVerifiedAt: new Date(),
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "email_taken"));
  });
});
