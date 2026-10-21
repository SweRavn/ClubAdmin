// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@clubadmin/db";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

describe("group hierarchy", () => {
  it("supports sections with child groups and rejects cycles (service)", async () => {
    const club = await buildClub(c.s);
    const section = await c.s.groups.createGroup(club.ctx, { name: "Fotboll", kind: "section" });
    const team = await c.s.groups.createGroup(club.ctx, {
      name: "P2012",
      kind: "team",
      parentGroupId: section.id,
    });
    const sub = await c.s.groups.createGroup(club.ctx, {
      name: "P2012 B",
      kind: "team",
      parentGroupId: team.id,
    });
    await expect(
      c.s.groups.updateGroup(club.ctx, section.id, { parentGroupId: sub.id }),
    ).rejects.toSatisfy((e) => isDomainError(e, "group_cycle"));
    await expect(
      c.s.groups.updateGroup(club.ctx, section.id, { parentGroupId: section.id }),
    ).rejects.toSatisfy(
      (e) => isDomainError(e, "group_cycle") || isDomainError(e, "group_parent_invalid"),
    );
    await c.t.db.withTenant(club.ctx, async (tx) => {
      expect(await c.s.groups.ancestorIdsInTx(tx, sub.id)).toEqual([sub.id, team.id, section.id]);
    });
  });

  it("rejects cycles in the database too", async () => {
    const club = await buildClub(c.s);
    const a = await c.s.groups.createGroup(club.ctx, { name: "A", kind: "section" });
    const b = await c.s.groups.createGroup(club.ctx, {
      name: "B",
      kind: "team",
      parentGroupId: a.id,
    });
    await expect(
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(sql`UPDATE groups SET parent_group_id = ${b.id} WHERE id = ${a.id}`),
      ),
    ).rejects.toMatchObject({ constraint: "groups_no_cycle" });
  });

  it("concurrent moves cannot form a cycle together", async () => {
    const club = await buildClub(c.s);
    const a = await c.s.groups.createGroup(club.ctx, { name: "A", kind: "section" });
    const b = await c.s.groups.createGroup(club.ctx, { name: "B", kind: "section" });
    const results = await Promise.allSettled([
      c.s.groups.updateGroup(club.ctx, a.id, { parentGroupId: b.id }),
      c.s.groups.updateGroup(club.ctx, b.id, { parentGroupId: a.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("rejects a parent from another club (service and database)", async () => {
    const club = await buildClub(c.s);
    const other = await buildClub(c.s);
    const foreign = await c.s.groups.createGroup(other.ctx, { name: "Foreign", kind: "section" });
    await expect(
      c.s.groups.createGroup(club.ctx, { name: "X", kind: "team", parentGroupId: foreign.id }),
    ).rejects.toSatisfy((e) => isDomainError(e, "group_parent_invalid"));
    await expect(
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(
          sql`INSERT INTO groups (club_id, name, kind, parent_group_id) VALUES (${club.id}, 'X', 'team', ${foreign.id})`,
        ),
      ),
    ).rejects.toMatchObject({ constraint: "groups_parent_same_club_fk" });
  });

  it("archives instead of deleting", async () => {
    const club = await buildClub(c.s);
    const group = await c.s.groups.createGroup(club.ctx, { name: "Old", kind: "team" });
    await c.s.groups.archiveGroup(club.ctx, group.id);
    expect((await c.s.groups.getGroup(club.ctx, group.id)).archivedAt).not.toBeNull();
    await expect(c.s.groups.updateGroup(club.ctx, group.id, { name: "New" })).rejects.toSatisfy(
      (e) => isDomainError(e, "group_archived"),
    );
    await expect(
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(sql`DELETE FROM groups WHERE id = ${group.id}`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("stores admission mode, capacity and per-season settings", async () => {
    const club = await buildClub(c.s);
    const group = await c.s.groups.createGroup(club.ctx, {
      name: "F2017",
      kind: "team",
      capacity: 10,
      admissionMode: "waitlist",
      birthYearFrom: 2017,
      birthYearTo: 2017,
      genderCategory: "female",
    });
    expect(group).toMatchObject({ capacity: 10, admissionMode: "waitlist", offerReplyDays: 7 });
    const season = await c.s.groups.createSeason(club.ctx, {
      name: "2026",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    });
    const id = await c.s.groups.setGroupSeason(club.ctx, group.id, season.id, { capacity: 12 });
    expect(await c.s.groups.setGroupSeason(club.ctx, group.id, season.id, { capacity: 14 })).toBe(
      id,
    );
  });
});

describe("group owners", () => {
  async function setup() {
    const club = await buildClub(c.s);
    const section = await c.s.groups.createGroup(club.ctx, { name: "Innebandy", kind: "section" });
    const team = await c.s.groups.createGroup(club.ctx, {
      name: "F2015",
      kind: "training_group",
      parentGroupId: section.id,
    });
    const owner = await buildPerson(c.s);
    const coOwner = await buildPerson(c.s);
    return { club, section, team, owner, coOwner };
  }

  it("club managers add and remove owners; groups may have several or none", async () => {
    const { club, team, owner, coOwner } = await setup();
    expect(await c.s.groups.owners(club.ctx, team.id)).toEqual([]);
    await c.s.groups.addOwner(club.ctx, team.id, owner.id, "club_manager");
    await c.s.groups.addOwner(club.ctx, team.id, coOwner.id, "club_manager");
    await expect(
      c.s.groups.addOwner(club.ctx, team.id, owner.id, "club_manager"),
    ).rejects.toSatisfy((e) => isDomainError(e, "already_group_owner"));
    expect((await c.s.groups.owners(club.ctx, team.id)).sort()).toEqual(
      [owner.id, coOwner.id].sort(),
    );
    await c.s.groups.removeOwner(club.ctx, team.id, coOwner.id, "club_manager");
    expect(await c.s.groups.owners(club.ctx, team.id)).toEqual([owner.id]);
  });

  it("owners appoint co-owners only when the club allows it", async () => {
    const { club, section, team, owner, coOwner } = await setup();
    await c.s.groups.addOwner(club.ctx, section.id, owner.id, "club_manager");
    const asOwner = actor(owner.id, club.id);
    await expect(
      c.s.groups.addOwner(asOwner, team.id, coOwner.id, "group_owner"),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
    await c.s.clubs.updateSettings(club.ctx, { ownersCanAppointCoOwners: true });
    // Owner of the parent section, so also of the team.
    await c.s.groups.addOwner(asOwner, team.id, coOwner.id, "group_owner");
    expect(await c.s.groups.owners(club.ctx, team.id)).toEqual([coOwner.id]);

    const stranger = await buildPerson(c.s);
    await expect(
      c.s.groups.removeOwner(actor(stranger.id, club.id), team.id, coOwner.id, "group_owner"),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
  });
});
