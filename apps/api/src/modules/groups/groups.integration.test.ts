// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@clubadmin/db";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf, historyOf, useCoreDatabase } from "../../testing/core.ts";

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

  it("archives and restores; a group with active subgroups is not archived", async () => {
    const club = await buildClub(c.s);
    const section = await c.s.groups.createGroup(club.ctx, { name: "Fotboll", kind: "section" });
    const team = await c.s.groups.createGroup(club.ctx, {
      name: "Old",
      kind: "team",
      parentGroupId: section.id,
    });
    await expect(c.s.groups.archiveGroup(club.ctx, section.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "group_has_children"),
    );
    await c.s.groups.archiveGroup(club.ctx, team.id);
    expect((await c.s.groups.getGroup(club.ctx, team.id)).archivedAt).not.toBeNull();
    await expect(c.s.groups.updateGroup(club.ctx, team.id, { name: "New" })).rejects.toSatisfy(
      (e) => isDomainError(e, "group_archived"),
    );
    await c.s.groups.archiveGroup(club.ctx, section.id);
    const restored = await c.s.groups.restoreGroup(club.ctx, team.id);
    expect(restored.archivedAt).toBeNull();
    expect(await auditActionsOf(c.t, team.id)).toEqual(
      expect.arrayContaining(["group.archived", "group.restored"]),
    );
  });

  it("deletes a group only while nothing refers to it (P1.6b)", async () => {
    const club = await buildClub(c.s);
    const unused = await c.s.groups.createGroup(club.ctx, { name: "Mistake", kind: "team" });
    expect(await c.s.groups.isDeletable(club.ctx, unused.id)).toBe(true);
    await c.s.groups.deleteGroup(club.ctx, unused.id);
    await expect(c.s.groups.getGroup(club.ctx, unused.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "not_found"),
    );
    expect((await historyOf(c.t, "public.groups", unused.id)).map((r) => r.operation)).toEqual([
      "INSERT",
      "DELETE",
    ]);
    expect(await auditActionsOf(c.t, unused.id)).toContain("group.deleted");

    const used = await c.s.groups.createGroup(club.ctx, { name: "Used", kind: "team" });
    const person = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, person.id);
    await c.s.memberships.addToGroup(club.ctx, used.id, person.id);
    expect(await c.s.groups.isDeletable(club.ctx, used.id)).toBe(false);
    await expect(c.s.groups.deleteGroup(club.ctx, used.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "group_in_use"),
    );
    // The foreign keys refuse it too.
    await expect(
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(sql`DELETE FROM groups WHERE id = ${used.id}`),
      ),
    ).rejects.toMatchObject({ code: "23503" });
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

describe("my waiting lists (P1.6b)", () => {
  it("shows my and my ward's open entries with the place in the queue", async () => {
    const club = await buildClub(c.s);
    const group = await c.s.groups.createGroup(club.ctx, {
      name: "P2016",
      kind: "team",
      admissionMode: "waitlist",
    });
    const first = await buildPerson(c.s);
    const second = await buildPerson(c.s);
    const prioritised = await buildPerson(c.s);
    const queue = async (personId: string, minutesAgo: number, priority = 0) =>
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(sql`
          INSERT INTO group_waitlist_entries (club_id, group_id, person_id, requested_by_person_id, queued_at, priority)
          VALUES (${club.id}, ${group.id}, ${personId}, ${personId},
            now() - make_interval(mins => ${minutesAgo}), ${priority})`),
      );
    await queue(first.id, 30);
    await queue(second.id, 20);
    await queue(prioritised.id, 10, 1);

    const mine = await c.s.groups.myWaitlistEntries(actor(second.id), [second.id]);
    expect(mine).toEqual([
      expect.objectContaining({
        clubId: club.id,
        groupId: group.id,
        groupName: "P2016",
        personId: second.id,
        status: "waiting",
        position: 3,
        waiting: 3,
      }),
    ]);
    // Only the caller's own entries.
    expect(await c.s.groups.myWaitlistEntries(actor(second.id), [first.id])).toEqual([]);
  });
});
