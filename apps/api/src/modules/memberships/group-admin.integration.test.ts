// SPDX-License-Identifier: AGPL-3.0-only
// Group administration (P1.10a) through the services: owners and who may
// own a group, adding and ending members with the capacity check, seasons,
// the candidate search, and archiving a group with people in it.

import { uuidv7 } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf, useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

async function clubWithTeam() {
  const club = await buildClub(c.s);
  const team = await c.s.groups.createGroup(club.ctx, { name: "F2016", kind: "team" });
  return { club, team };
}

async function member(club: Awaited<ReturnType<typeof buildClub>>, birthDate = "1985-04-12") {
  const person = await buildPerson(c.s, { birthDate });
  await c.s.memberships.addMember(club.ctx, person.id);
  return person;
}

async function waitlistEntry(clubId: string, groupId: string, personId: string): Promise<string> {
  const { rows } = await c.t.query<{ id: string }>(
    "admin",
    `INSERT INTO group_waitlist_entries (club_id, group_id, person_id, requested_by_person_id)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [clubId, groupId, personId],
  );
  return rows[0]!.id;
}

describe("group owners", () => {
  it("appoints adult members with a login, and refuses children and outsiders", async () => {
    const { club, team } = await clubWithTeam();
    const adult = await member(club);
    await c.s.memberships.addGroupOwner(club.ctx, team.id, adult.id, "club_manager");
    expect(await c.s.groups.owners(club.ctx, team.id)).toContain(adult.id);

    const family = await buildFamily(c.s, { club, childBirthDate: "2012-05-01" });
    await expect(
      c.s.memberships.addGroupOwner(club.ctx, team.id, family.child.id, "club_manager"),
    ).rejects.toSatisfy((e) => isDomainError(e, "owner_not_eligible"));

    const outsider = await buildPerson(c.s);
    await expect(
      c.s.memberships.addGroupOwner(club.ctx, team.id, outsider.id, "club_manager"),
    ).rejects.toSatisfy((e) => isDomainError(e, "owner_not_eligible"));
    await expect(
      c.s.memberships.addGroupOwner(club.ctx, team.id, adult.id, "club_manager"),
    ).rejects.toSatisfy((e) => isDomainError(e, "already_group_owner"));
  });

  it("lets owners appoint co-owners only with the club setting", async () => {
    const { club, team } = await clubWithTeam();
    const owner = await member(club);
    const coOwner = await member(club);
    await c.s.memberships.addGroupOwner(club.ctx, team.id, owner.id, "club_manager");
    const asOwner = actor(owner.id, club.id);
    await expect(
      c.s.memberships.addGroupOwner(asOwner, team.id, coOwner.id, "group_owner"),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_allowed"));
    await c.s.clubs.updateSettings(club.ctx, { ownersCanAppointCoOwners: true });
    await c.s.memberships.addGroupOwner(asOwner, team.id, coOwner.id, "group_owner");
    expect(await c.s.groups.owners(club.ctx, team.id)).toEqual(
      expect.arrayContaining([owner.id, coOwner.id]),
    );
  });
});

describe("members and capacity", () => {
  it("refuses a member past the capacity unless overridden; leaders never count", async () => {
    const { club, team } = await clubWithTeam();
    await c.s.groups.updateGroup(club.ctx, team.id, { capacity: 1 });
    const [a, b, coach] = [await member(club), await member(club), await member(club)];
    await c.s.memberships.addGroupMember(club.ctx, team.id, a.id, "member");
    await c.s.memberships.addGroupMember(club.ctx, team.id, coach.id, "head_coach");
    await expect(
      c.s.memberships.addGroupMember(club.ctx, team.id, b.id, "member"),
    ).rejects.toSatisfy((e) => isDomainError(e, "group_full"));
    const row = await c.s.memberships.addGroupMember(club.ctx, team.id, b.id, "member", {
      overCapacity: true,
    });
    const { rows } = await c.t.query<{ changed_fields: string[] }>(
      "admin",
      "SELECT changed_fields FROM audit.events WHERE resource_id = $1 ORDER BY created_at",
      [row.id],
    );
    expect(rows.map((r) => r.changed_fields)).toContainEqual(["over_capacity"]);
    await expect(
      c.s.memberships.addGroupMember(club.ctx, team.id, uuidv7(), "member", {
        overCapacity: true,
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_a_member"));
  });

  it("uses the capacity of the season covering today", async () => {
    const { club, team } = await clubWithTeam();
    await c.s.groups.updateGroup(club.ctx, team.id, { capacity: 20 });
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const season = await c.s.groups.createSeason(club.ctx, {
      name: "Now",
      startsOn: iso(new Date(today.getTime() - 30 * 86_400_000)),
      endsOn: iso(new Date(today.getTime() + 30 * 86_400_000)),
    });
    await c.s.groups.setGroupSeason(club.ctx, team.id, season.id, { capacity: 3 });
    await c.t.db.withTenant(club.ctx, async (tx) => {
      expect(await c.s.groups.capacityInTx(tx, team.id)).toEqual({ capacity: 3, occupied: 0 });
    });
    expect((await c.s.groups.listSeasons(club.ctx)).map((s) => s.id)).toContain(season.id);
  });

  it("ends one function, only through its own group", async () => {
    const { club, team } = await clubWithTeam();
    const other = await c.s.groups.createGroup(club.ctx, { name: "Other", kind: "team" });
    const person = await member(club);
    const row = await c.s.memberships.addGroupMember(club.ctx, team.id, person.id, "member");
    await expect(
      c.s.memberships.endMembershipInGroup(club.ctx, other.id, row.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_found"));
    await c.s.memberships.endMembershipInGroup(club.ctx, team.id, row.id);
    expect(await auditActionsOf(c.t, row.id)).toContain("group.membership.ended");
  });

  it("finds candidates by name, leaving out those who hold the function", async () => {
    const { club, team } = await clubWithTeam();
    const anna = await buildPerson(c.s, { givenName: "Annabel", familyName: "Kandidat" });
    const bo = await buildPerson(c.s, { givenName: "Annabelle", familyName: "Kandidat" });
    await c.s.memberships.addMember(club.ctx, anna.id);
    await c.s.memberships.addMember(club.ctx, bo.id);
    await c.s.memberships.addGroupMember(club.ctx, team.id, bo.id, "member");
    const page = await c.s.memberships.groupCandidates(club.ctx, team.id, {
      q: "annab",
      function: "member",
      limit: 20,
    });
    expect(page.items.map((i) => i.personId)).toEqual([anna.id]);
    const any = await c.s.memberships.groupCandidates(club.ctx, team.id, { q: "annab", limit: 1 });
    expect(any.items).toHaveLength(1);
    expect(any.nextCursor).not.toBeNull();
    const next = await c.s.memberships.groupCandidates(club.ctx, team.id, {
      q: "annab",
      limit: 1,
      cursor: any.nextCursor!,
    });
    expect(next.items.map((i) => i.personId)).not.toContain(any.items[0]!.personId);
  });
});

describe("archiving a group with people in it", () => {
  it("ends every membership, closes the waiting list and keeps the owners", async () => {
    const { club, team } = await clubWithTeam();
    const [player, coach, owner, applicant] = [
      await member(club),
      await member(club),
      await member(club),
      await member(club),
    ];
    await c.s.memberships.addGroupMember(club.ctx, team.id, player.id, "member");
    await c.s.memberships.addGroupMember(club.ctx, team.id, coach.id, "head_coach");
    await c.s.memberships.addGroupOwner(club.ctx, team.id, owner.id, "club_manager");
    const entry = await waitlistEntry(club.id, team.id, applicant.id);

    expect(await c.s.memberships.archivePreview(club.ctx, team.id)).toEqual({
      members: 1,
      leaders: 1,
      waitlist: 1,
      activeChildren: 0,
    });
    expect(await c.s.memberships.archiveGroup(club.ctx, team.id)).toEqual({
      members: 1,
      leaders: 1,
      waitlist: 1,
    });
    const { rows: open } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM group_memberships WHERE group_id = $1 AND valid_to IS NULL",
      [team.id],
    );
    expect(open[0]!.n).toBe(0);
    const { rows: entries } = await c.t.query<{ status: string; closed_reason: string }>(
      "admin",
      "SELECT status, closed_reason FROM group_waitlist_entries WHERE id = $1",
      [entry],
    );
    expect(entries[0]).toEqual({ status: "removed", closed_reason: "group_archived" });
    const { rows: events } = await c.t.query<{ payload: { entryId: string } }>(
      "admin",
      "SELECT payload FROM outbox.events WHERE type = 'waitlist.entry.closed'",
    );
    expect(events.map((e) => e.payload.entryId)).toContain(entry);
    expect(await auditActionsOf(c.t, entry)).toContain("group.waitlist.closed");
    expect(await c.s.groups.owners(club.ctx, team.id)).toContain(owner.id);
    // Archiving again changes nothing.
    expect(await c.s.memberships.archiveGroup(club.ctx, team.id)).toEqual({
      members: 0,
      leaders: 0,
      waitlist: 0,
    });
    await expect(
      c.s.memberships.addGroupMember(club.ctx, team.id, player.id, "member"),
    ).rejects.toSatisfy((e) => isDomainError(e, "group_archived"));
  });

  it("closes the entries of someone who leaves the club with left_club", async () => {
    const { club, team } = await clubWithTeam();
    const applicant = await member(club);
    const entry = await waitlistEntry(club.id, team.id, applicant.id);
    await c.s.leaving.leave(actor(applicant.id, club.id), applicant.id, { removeNow: false });
    const { rows } = await c.t.query<{ status: string; closed_reason: string }>(
      "admin",
      "SELECT status, closed_reason FROM group_waitlist_entries WHERE id = $1",
      [entry],
    );
    expect(rows[0]).toEqual({ status: "withdrawn", closed_reason: "left_club" });
  });
});
