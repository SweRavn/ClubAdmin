// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@clubadmin/db";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { historyOf, useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();
const address = { street: "Storgatan 1", postalCode: "111 22", city: "Stockholm", country: "SE" };

describe("people", () => {
  it("stores the personal identity number encrypted, with a blind index, and redacts it in history", async () => {
    const parent = await buildPerson(c.s);
    const { child } = await c.s.guardianships.addChild(actor(parent.id), {
      givenName: "Tolvan",
      familyName: "Test",
      birthDate: "1935-12-20",
      personalIdentityNumber: { country: "SE", value: "351220-8194" },
    });
    expect(child.hasPersonalIdentityNumber).toBe(true);

    const { rows } = await c.t.query<{
      personal_identity_number: string;
      personal_identity_number_hash: string;
    }>(
      "admin",
      "SELECT personal_identity_number, personal_identity_number_hash FROM people WHERE id = $1",
      [child.id],
    );
    expect(rows[0]?.personal_identity_number).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain("8194");
    expect(rows[0]?.personal_identity_number_hash).toBe(
      c.s.people.personalIdentityNumberHash("SE", "193512208194"),
    );

    const { rows: history } = await c.t.query<{ new_values: Record<string, unknown> }>(
      "admin",
      "SELECT new_values FROM history.record_changes WHERE record_id = $1 AND table_name = 'public.people'",
      [child.id],
    );
    expect(history[0]?.new_values.personal_identity_number).toBe("[changed]");
    expect(history[0]?.new_values.personal_identity_number_hash).toBe("[changed]");

    expect(await c.s.people.revealPersonalIdentityNumber(actor(parent.id), child.id)).toEqual({
      country: "SE",
      value: "193512208194",
    });
  });

  it("validates the personal identity number against the country pack and birth date", async () => {
    const p = await buildPerson(c.s);
    const base = { givenName: "A", familyName: "B", birthDate: "1935-12-20" };
    await expect(
      c.s.guardianships.addChild(actor(p.id), {
        ...base,
        personalIdentityNumber: { country: "SE", value: "351220-8195" },
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "invalid_personal_identity_number"));
    await expect(
      c.s.guardianships.addChild(actor(p.id), {
        ...base,
        birthDate: "1935-12-21",
        personalIdentityNumber: { country: "SE", value: "351220-8194" },
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "personal_identity_number_mismatch"));
  });

  it("never stores an address for protected persons (service and database)", async () => {
    const p = await buildPerson(c.s);
    await expect(
      c.s.people.createPerson(actor(p.id), {
        givenName: "N",
        familyName: "K",
        birthDate: "2015-05-05",
        protectedIdentity: true,
        address,
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "protected_address"));
    await expect(
      c.t.query(
        "admin",
        `UPDATE people SET protected_identity = true, address = '{"street":"x"}'::jsonb WHERE id = $1`,
        [p.id],
      ),
    ).rejects.toMatchObject({ constraint: "people_protected_no_address" });
  });

  it("protected identity: self or full guardian only; turning it on removes the address; audited with an event", async () => {
    const family = await buildFamily(c.s);
    const child = family.child;
    await c.s.people.updateProfile(actor(family.guardian.id), child.id, { address });

    const relative = await buildPerson(c.s);
    await c.s.guardianships.addGuardian(actor(family.guardian.id), {
      guardianPersonId: relative.id,
      wardPersonId: child.id,
      kind: "relative",
    });
    for (const someone of [relative, await buildPerson(c.s)]) {
      await expect(
        c.s.people.setProtectedIdentity(actor(someone.id), child.id, true),
      ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed") || isDomainError(e, "not_found"));
    }

    const protectedChild = await c.s.people.setProtectedIdentity(
      actor(family.coGuardian.id),
      child.id,
      true,
    );
    expect(protectedChild).toMatchObject({ protectedIdentity: true, address: null });
    await expect(
      c.s.people.updateProfile(actor(family.guardian.id), child.id, { address }),
    ).rejects.toSatisfy((e) => isDomainError(e, "protected_address"));

    const self = await buildPerson(c.s);
    await c.s.people.setProtectedIdentity(actor(self.id), self.id, true);

    const { rows } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'person.protection.changed' AND payload ->> 'personId' = ANY ($1)",
      [[child.id, self.id]],
    );
    expect(rows[0]?.n).toBe(2);
    const { rows: audits } = await c.t.query<{ actor_person_id: string; changed_fields: string[] }>(
      "admin",
      "SELECT actor_person_id, changed_fields FROM audit.events WHERE action = 'person.protection.changed' AND resource_id = $1",
      [child.id],
    );
    expect(audits).toEqual([
      { actor_person_id: family.coGuardian.id, changed_fields: ["protected_identity", "address"] },
    ]);
  });

  it("records history with the actor for profile updates", async () => {
    const p = await buildPerson(c.s);
    await c.s.people.updateProfile(actor(p.id), p.id, { phone: "+46 70 000 00 00" });
    const history = await historyOf(c.t, "public.people", p.id);
    expect(history.at(-1)).toMatchObject({
      operation: "UPDATE",
      changed_columns: ["phone"],
      actor_person_id: p.id,
    });
  });

  it("people are reachable only by themselves, their family and their clubs", async () => {
    const club = await buildClub(c.s);
    const family = await buildFamily(c.s, { club });
    const stranger = await buildPerson(c.s);
    const see = (ctx: Parameters<typeof c.s.people.getPerson>[0], id: string) =>
      c.s.people.getPerson(ctx, id).then(
        () => true,
        (e: unknown) => {
          if (isDomainError(e, "not_found")) return false;
          throw e;
        },
      );

    expect(await see(actor(stranger.id), family.child.id)).toBe(false);
    expect(await see(actor(stranger.id), family.guardian.id)).toBe(false);
    expect(await see(actor(family.coGuardian.id), family.guardian.id)).toBe(true); // co-guardians
    expect(await see(actor(family.coGuardian.id), family.child.id)).toBe(true);
    expect(await see(club.ctx, family.child.id)).toBe(true); // member of the club
    expect(await see(club.ctx, family.guardian.id)).toBe(true); // guardian of a member
    expect(await see(club.ctx, stranger.id)).toBe(false);
    const otherClub = await buildClub(c.s);
    expect(await see(otherClub.ctx, family.child.id)).toBe(false);

    const updated = await c.t.db.withActor(actor(stranger.id), (tx) =>
      tx.execute(sql`UPDATE people SET given_name = 'X' WHERE id = ${family.child.id}`),
    );
    expect(updated.rowCount).toBe(0);
  });
});
