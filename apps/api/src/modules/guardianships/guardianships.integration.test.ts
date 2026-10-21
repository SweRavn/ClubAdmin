// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@clubadmin/db";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

describe("guardianships", () => {
  it("'Add child' creates a person without account, with full parent rights", async () => {
    const parent = await buildPerson(c.s);
    const { child, guardianship } = await c.s.guardianships.addChild(actor(parent.id), {
      givenName: "Viktor",
      familyName: "Malm",
      birthDate: "2018-06-01",
    });
    expect(guardianship).toMatchObject({
      kind: "parent",
      status: "active",
      guardianPersonId: parent.id,
    });
    expect(guardianship.rights).toEqual([
      "act_on_behalf",
      "receive_messages",
      "view_schedule",
      "sign_up",
      "see_medical",
    ]);
    const { rows } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM accounts WHERE person_id = $1",
      [child.id],
    );
    expect(rows[0]?.n).toBe(0);
    expect(await c.s.guardianships.wardsOf(actor(parent.id), parent.id)).toEqual([guardianship]);
  });

  it("a co-guardian is invited by email and becomes guardian on accepting; tokens work once", async () => {
    const family = await buildFamily(c.s);
    const guardians = await c.s.guardianships.guardiansOf(
      actor(family.guardian.id),
      family.child.id,
    );
    expect(guardians.map((g) => g.guardianPersonId).sort()).toEqual(
      [family.guardian.id, family.coGuardian.id].sort(),
    );

    const { token } = await c.s.guardianships.inviteCoGuardian(actor(family.guardian.id), {
      wardPersonId: family.child.id,
      email: "someone@example.test",
    });
    const { rows } = await c.t.query<{ token_hash: string }>(
      "admin",
      "SELECT token_hash FROM guardian_invitations WHERE email = 'someone@example.test'",
    );
    expect(rows[0]?.token_hash).not.toBe(token);
    const invitee = await buildPerson(c.s);
    await c.s.guardianships.acceptInvitation(actor(invitee.id), token);
    const late = await buildPerson(c.s);
    await expect(c.s.guardianships.acceptInvitation(actor(late.id), token)).rejects.toSatisfy((e) =>
      isDomainError(e, "invitation_invalid"),
    );
    await expect(c.s.guardianships.acceptInvitation(actor(late.id), "made-up")).rejects.toSatisfy(
      (e) => isDomainError(e, "invitation_invalid"),
    );
  });

  it("only full guardians invite or grant relatives, who default to view-only", async () => {
    const family = await buildFamily(c.s);
    const grandmother = await buildPerson(c.s);
    const stranger = await buildPerson(c.s);
    await expect(
      c.s.guardianships.inviteCoGuardian(actor(stranger.id), {
        wardPersonId: family.child.id,
        email: "x@example.test",
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
    await expect(
      c.s.guardianships.addGuardian(actor(stranger.id), {
        guardianPersonId: grandmother.id,
        wardPersonId: family.child.id,
        kind: "relative",
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
    const relative = await c.s.guardianships.addGuardian(actor(family.guardian.id), {
      guardianPersonId: grandmother.id,
      wardPersonId: family.child.id,
      kind: "relative",
    });
    expect(relative.rights).toEqual(["view_schedule"]);
    const updated = await c.s.guardianships.updateRights(actor(family.coGuardian.id), relative.id, [
      "view_schedule",
      "receive_messages",
    ]);
    expect(updated.rights).toEqual(["view_schedule", "receive_messages"]);
    await expect(
      c.s.guardianships.updateRights(actor(grandmother.id), relative.id, ["act_on_behalf"]),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
  });

  it("full guardians cannot remove each other; a club manager can", async () => {
    const club = await buildClub(c.s);
    const family = await buildFamily(c.s, { club });
    const [, second] = family.guardianships;
    await expect(
      c.s.guardianships.endGuardianship(actor(family.guardian.id), second!.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
    await expect(
      c.s.guardianships.endGuardianship(actor(family.guardian.id, club.id), second!.id, {
        allowedBy: "club_manager",
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
    await c.s.guardianships.endGuardianship(club.ctx, second!.id, { allowedBy: "club_manager" });
    const guardians = await c.s.guardianships.guardiansOf(
      actor(family.guardian.id),
      family.child.id,
    );
    expect(guardians.map((g) => g.guardianPersonId)).toEqual([family.guardian.id]);
    const { rows } = await c.t.query<{ status: string }>(
      "admin",
      "SELECT status FROM guardianships WHERE id = $1",
      [second!.id],
    );
    expect(rows[0]?.status).toBe("ended"); // ended, never deleted
  });

  it("guardianships are visible to the family and the ward's clubs only", async () => {
    const club = await buildClub(c.s);
    const family = await buildFamily(c.s, { club });
    const other = await buildClub(c.s);
    const stranger = await buildPerson(c.s);
    const count = async (ctx: Parameters<typeof c.t.db.withActor>[0]) =>
      (
        await c.t.db.withActor(ctx, (tx) =>
          tx.execute(sql`SELECT id FROM guardianships WHERE ward_person_id = ${family.child.id}`),
        )
      ).rows.length;
    expect(await count(actor(stranger.id))).toBe(0);
    expect(await count(actor(family.coGuardian.id))).toBe(2);
    expect(
      await c.t.db
        .withTenant(club.ctx, (tx) =>
          tx.execute(sql`SELECT id FROM guardianships WHERE ward_person_id = ${family.child.id}`),
        )
        .then((r) => r.rows.length),
    ).toBe(2);
    expect(
      await c.t.db
        .withTenant(other.ctx, (tx) =>
          tx.execute(sql`SELECT id FROM guardianships WHERE ward_person_id = ${family.child.id}`),
        )
        .then((r) => r.rows.length),
    ).toBe(0);
  });
});
