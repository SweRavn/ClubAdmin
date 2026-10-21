// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

/**
 * Both parents added the same child: Anna created Elsa (in club A, group G),
 * Mikael created "Elsa" again (in club B). Each invited the other as guardian.
 */
async function duplicateChild() {
  const anna = await buildPerson(c.s);
  const mikael = await buildPerson(c.s);
  const clubA = await buildClub(c.s);
  const clubB = await buildClub(c.s);
  const child = { givenName: "Elsa", familyName: "Lindqvist", birthDate: "2017-02-02" };
  const { child: elsa } = await c.s.guardianships.addChild(actor(anna.id), child);
  const { child: duplicate } = await c.s.guardianships.addChild(actor(mikael.id), child);
  const invite1 = await c.s.guardianships.inviteCoGuardian(actor(anna.id), {
    wardPersonId: elsa.id,
    email: mikael.email!,
  });
  await c.s.guardianships.acceptInvitation(actor(mikael.id), invite1.token);
  const invite2 = await c.s.guardianships.inviteCoGuardian(actor(mikael.id), {
    wardPersonId: duplicate.id,
    email: anna.email!,
  });
  await c.s.guardianships.acceptInvitation(actor(anna.id), invite2.token);

  await c.s.memberships.addMember(clubA.ctx, elsa.id);
  const group = await c.s.groups.createGroup(clubB.ctx, { name: "F2017", kind: "team" });
  await c.s.memberships.addMember(clubB.ctx, duplicate.id);
  await c.s.memberships.addToGroup(clubB.ctx, group.id, duplicate.id);
  return { anna, mikael, clubA, clubB, elsa, duplicate, group };
}

describe("merging duplicate people", () => {
  it("a guardian of both moves every relationship to the kept person, in all clubs", async () => {
    const f = await duplicateChild();
    const merge = await c.s.merge.merge(actor(f.anna.id), f.elsa.id, f.duplicate.id);
    expect(merge.movedReferences.length).toBeGreaterThan(0);

    const mine = await c.s.memberships.myClubsAndGroups(actor(f.anna.id), f.elsa.id);
    expect(mine.clubs.map((m) => m.clubId).sort()).toEqual([f.clubA.id, f.clubB.id].sort());
    expect(mine.groups.map((g) => g.groupId)).toEqual([f.group.id]);
    const guardians = await c.s.guardianships.guardiansOf(actor(f.anna.id), f.elsa.id);
    expect(guardians.map((g) => g.guardianPersonId).sort()).toEqual(
      [f.anna.id, f.mikael.id].sort(),
    );
    expect(await c.s.guardianships.guardiansOf(actor(f.anna.id), f.duplicate.id)).toEqual([]);

    // The duplicate stays as a stub, no longer reachable through any relationship.
    const { rows } = await c.t.query<{ merged_into_person_id: string }>(
      "admin",
      "SELECT merged_into_person_id FROM people WHERE id = $1",
      [f.duplicate.id],
    );
    expect(rows[0]?.merged_into_person_id).toBe(f.elsa.id);
    await expect(c.s.people.getPerson(actor(f.anna.id), f.duplicate.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "not_found"),
    );
    // The kept person got the duplicate's profile in club B (with its member number).
    expect((await c.s.profiles.getProfile(f.clubB.ctx, f.elsa.id)).memberNumber).toBe(2);
  });

  it("can be undone within 30 days, restoring every relationship", async () => {
    const f = await duplicateChild();
    const before = await c.s.memberships.myClubsAndGroups(actor(f.anna.id), f.duplicate.id);
    const merge = await c.s.merge.merge(actor(f.anna.id), f.elsa.id, f.duplicate.id);
    await c.s.merge.undo(actor(f.mikael.id), merge.id);

    expect(await c.s.memberships.myClubsAndGroups(actor(f.anna.id), f.duplicate.id)).toEqual(
      before,
    );
    const guardians = await c.s.guardianships.guardiansOf(actor(f.anna.id), f.duplicate.id);
    expect(guardians.map((g) => g.guardianPersonId).sort()).toEqual(
      [f.anna.id, f.mikael.id].sort(),
    );
    expect(
      (await c.s.people.getPerson(actor(f.anna.id), f.duplicate.id)).mergedIntoPersonId,
    ).toBeNull();
    await expect(c.s.merge.undo(actor(f.anna.id), merge.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "not_found"),
    );
  });

  it("undo expires after 30 days", async () => {
    const f = await duplicateChild();
    const merge = await c.s.merge.merge(actor(f.anna.id), f.elsa.id, f.duplicate.id);
    await c.t.query(
      "admin",
      "UPDATE people_merges SET undo_until = now() - interval '1 day' WHERE id = $1",
      [merge.id],
    );
    await expect(c.s.merge.undo(actor(f.anna.id), merge.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "merge_undo_expired"),
    );
  });

  it("is refused for people without the right, and for people with a login", async () => {
    const f = await duplicateChild();
    const stranger = await buildPerson(c.s);
    await expect(c.s.merge.merge(actor(stranger.id), f.elsa.id, f.duplicate.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "not_found") || isDomainError(e, "merge_not_allowed"),
    );
    await expect(c.s.merge.merge(actor(f.anna.id), f.duplicate.id, f.anna.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "merge_not_allowed"),
    );
  });

  it("a club manager merges two members of their club", async () => {
    const club = await buildClub(c.s);
    const a = await c.s.people.createPerson(club.ctx, {
      givenName: "Ola",
      familyName: "Dup",
      birthDate: "1990-01-01",
    });
    const b = await c.s.people.createPerson(club.ctx, {
      givenName: "Ola",
      familyName: "Dup",
      birthDate: "1990-01-01",
    });
    await c.s.memberships.addMember(club.ctx, a.id);
    await c.s.memberships.addMember(club.ctx, b.id);
    await c.s.merge.merge(club.ctx, a.id, b.id);
    const { rows } = await c.t.query<{ person_id: string; status: string }>(
      "admin",
      "SELECT person_id, status FROM club_memberships WHERE club_id = $1 AND person_id = ANY ($2) ORDER BY valid_to NULLS FIRST",
      [club.id, [a.id, b.id]],
    );
    // b's membership was ended (a already had one) and moved to a.
    expect(rows).toEqual([
      { person_id: a.id, status: "active" },
      { person_id: a.id, status: "left" },
    ]);
  });
});
