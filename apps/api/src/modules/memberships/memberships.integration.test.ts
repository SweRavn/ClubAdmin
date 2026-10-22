// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

describe("club memberships", () => {
  it("joins open clubs at once; other clubs decide on a join request", async () => {
    const open = await buildClub(c.s, { joinPolicy: "open" });
    const approval = await buildClub(c.s);
    const inviteOnly = await buildClub(c.s, { joinPolicy: "invite_only" });
    const p = await buildPerson(c.s);

    expect((await c.s.memberships.joinClub(actor(p.id, open.id), p.id)).status).toBe("active");
    await expect(c.s.memberships.joinClub(actor(p.id, approval.id), p.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "join_not_allowed"),
    );
    await expect(c.s.memberships.joinClub(actor(p.id, inviteOnly.id), p.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "join_not_allowed"),
    );
    await expect(c.s.memberships.joinClub(actor(p.id, open.id), p.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "already_member"),
    );
  });

  it("a guardian joins for a child", async () => {
    const club = await buildClub(c.s, { joinPolicy: "open" });
    const family = await buildFamily(c.s);
    const m = await c.s.memberships.joinClub(actor(family.guardian.id, club.id), family.child.id);
    expect(m.personId).toBe(family.child.id);
    const mine = await c.s.memberships.myClubsAndGroups(actor(family.guardian.id), family.child.id);
    expect(mine.clubs.map((x) => x.clubId)).toEqual([club.id]);
  });

  it("member numbers are unique per club under concurrent inserts", async () => {
    const club = await buildClub(c.s);
    const people = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        c.s.people.createPerson(club.ctx, {
          givenName: `P${i}`,
          familyName: "Many",
          birthDate: "2000-01-01",
        }),
      ),
    );
    await Promise.all(people.map((p) => c.s.memberships.addMember(club.ctx, p.id)));
    const { rows } = await c.t.query<{ member_number: number }>(
      "admin",
      "SELECT member_number FROM club_profiles WHERE club_id = $1 ORDER BY member_number",
      [club.id],
    );
    expect(rows.map((r) => r.member_number)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    const other = await buildClub(c.s);
    expect((await c.s.profiles.getProfile(other.ctx, other.manager.id)).memberNumber).toBe(1);
  });

  it("leaving ends the membership, group memberships, ownerships and roles; rows are kept", async () => {
    const club = await buildClub(c.s);
    const p = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, p.id);
    const group = await c.s.groups.createGroup(club.ctx, { name: "Herr", kind: "team" });
    await c.s.memberships.addToGroup(club.ctx, group.id, p.id, "member");
    await c.s.memberships.addToGroup(club.ctx, group.id, p.id, "assistant_coach");
    await c.s.groups.addOwner(club.ctx, group.id, p.id, "club_manager");
    await c.s.roles.assignRole(club.ctx, p.id, "board_member");

    await c.s.memberships.leaveClub(club.ctx, p.id);
    expect(await c.s.memberships.groupMembers(club.ctx, group.id)).toEqual([]);
    expect(await c.s.groups.owners(club.ctx, group.id)).toEqual([]);
    const { rows } = await c.t.query<{ t: string; open: number; total: number }>(
      "admin",
      `SELECT 'membership' AS t, count(*) FILTER (WHERE valid_to IS NULL)::int AS open, count(*)::int AS total FROM club_memberships WHERE person_id = $1
       UNION ALL SELECT 'group', count(*) FILTER (WHERE valid_to IS NULL)::int, count(*)::int FROM group_memberships WHERE person_id = $1
       UNION ALL SELECT 'role', count(*) FILTER (WHERE valid_to IS NULL)::int, count(*)::int FROM club_role_assignments WHERE person_id = $1`,
      [p.id],
    );
    expect(rows).toEqual([
      { t: "membership", open: 0, total: 1 },
      { t: "group", open: 0, total: 2 },
      { t: "role", open: 0, total: 1 },
    ]);
    // Rejoining starts a new membership; the profile and member number stay.
    const again = await c.s.memberships.addMember(club.ctx, p.id);
    expect(again.status).toBe("active");
    expect((await c.s.profiles.getProfile(club.ctx, p.id)).memberNumber).toBe(2);
  });

  it("group membership needs an active club membership and an open group", async () => {
    const club = await buildClub(c.s);
    const outsider = await buildPerson(c.s);
    const group = await c.s.groups.createGroup(club.ctx, { name: "G", kind: "team" });
    await expect(c.s.memberships.addToGroup(club.ctx, group.id, outsider.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "not_a_member"),
    );
    await c.s.memberships.addMember(club.ctx, outsider.id);
    const gm = await c.s.memberships.addToGroup(club.ctx, group.id, outsider.id, "head_coach");
    await expect(
      c.s.memberships.addToGroup(club.ctx, group.id, outsider.id, "head_coach"),
    ).rejects.toSatisfy((e) => isDomainError(e, "already_in_group"));
    expect(await c.s.memberships.groupMembers(club.ctx, group.id)).toEqual([
      { id: gm.id, personId: outsider.id, function: "head_coach" },
    ]);
    await c.s.memberships.endGroupMembership(club.ctx, gm.id);
    expect(await c.s.memberships.groupMembers(club.ctx, group.id)).toEqual([]);
  });

  it("my clubs and groups span clubs, and include only my rows", async () => {
    const a = await buildClub(c.s);
    const b = await buildClub(c.s, { country: "NO" });
    const p = await buildPerson(c.s);
    for (const club of [a, b]) await c.s.memberships.addMember(club.ctx, p.id);
    const g = await c.s.groups.createGroup(b.ctx, { name: "Veteran", kind: "team" });
    await c.s.memberships.addToGroup(b.ctx, g.id, p.id);

    const mine = await c.s.memberships.myClubsAndGroups(actor(p.id), p.id);
    expect(mine.clubs.map((x) => x.clubId).sort()).toEqual([a.id, b.id].sort());
    expect(mine.groups).toEqual([
      expect.objectContaining({ groupId: g.id, name: "Veteran", function: "member" }),
    ]);

    const stranger = await buildPerson(c.s);
    expect(await c.s.memberships.myClubsAndGroups(actor(stranger.id), p.id)).toEqual({
      clubs: [],
      groups: [],
    });
  });
});

describe("club profiles", () => {
  it("club-level protection: club managers only, audited, with an event", async () => {
    const club = await buildClub(c.s);
    const p = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, p.id);
    await expect(
      c.s.profiles.setClubProtection(actor(p.id, club.id), p.id, true),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_a_club_manager"));
    const profile = await c.s.profiles.setClubProtection(club.ctx, p.id, true);
    expect(profile.protectedIdentityClub).toBe(true);
    const { rows } = await c.t.query<{ action: string }>(
      "admin",
      "SELECT action FROM audit.events WHERE resource_id = $1",
      [profile.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["person.protection.changed"]);
    const { rows: events } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'person.protection.changed' AND payload ->> 'clubId' = $1",
      [club.id],
    );
    expect(events[0]?.n).toBe(1);
  });

  it("updates shared fields and emergency contacts", async () => {
    const club = await buildClub(c.s);
    const profile = await c.s.profiles.updateProfile(club.ctx, club.manager.id, {
      sharedFields: ["phone"],
      emergencyContacts: [{ name: "Someone", phone: "+46 70 111 22 33" }],
    });
    expect(profile).toMatchObject({
      sharedFields: ["phone"],
      emergencyContacts: [{ name: "Someone" }],
    });
  });
});
