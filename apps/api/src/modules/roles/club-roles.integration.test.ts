// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles, part A2 (P1.15, ADR 0046): administrators create,
// change, preview, delete and assign roles; locked roles keep their locked
// permissions; a role's change reaches its holders (outbox events for the
// cache and the notices); custom group roles take part or lead by their
// permissions.

import { sql } from "@clubadmin/db";
import { BUILT_IN_ROLE_TEMPLATE, MANAGER_SPLIT } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { buildClub, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

async function events(clubId: string, type: string) {
  const { rows } = await c.t.query<{ payload: Record<string, unknown> }>(
    "admin",
    "SELECT payload FROM outbox.events WHERE club_id = $1 AND type = $2 ORDER BY created_at",
    [clubId, type],
  );
  return rows.map((r) => r.payload);
}

describe("club-defined roles (P1.15 A2)", () => {
  it("the club manager administers, the registrar does the register's work", () => {
    const manager = BUILT_IN_ROLE_TEMPLATE.club_manager.permissions;
    const registrar = BUILT_IN_ROLE_TEMPLATE.registrar.permissions;
    for (const p of MANAGER_SPLIT) {
      expect(manager, p).not.toContain(p);
      expect(registrar, p).toContain(p);
    }
    expect(manager).toEqual(
      expect.arrayContaining(["club.roles.manage", "club.people.protected", "club.roles.read"]),
    );
  });

  it("creates, renames, changes and resets roles; locked permissions stay", async () => {
    const club = await buildClub(c.s);
    const roles = await c.s.clubRoles.listRoles(club.ctx);
    const manager = roles.roles.find((r) => r.templateKey === "club_manager")!;
    expect(manager.locked).toBe(true);
    await expect(
      c.s.clubRoles.updateRole(club.ctx, manager.id, {
        version: manager.version,
        permissions: manager.permissions.filter((p) => p !== "club.people.protected"),
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "role_locked"));
    await expect(c.s.clubRoles.deleteRole(club.ctx, manager.id, undefined)).rejects.toSatisfy((e) =>
      isDomainError(e, "role_locked"),
    );

    const own = await c.s.clubRoles.createRole(club.ctx, {
      scope: "group",
      names: { sv: "Materialansvarig" },
      permissions: ["group.activities.manage"],
    });
    expect(own).toMatchObject({ templateKey: null, locked: false, version: 1 });
    // A group role holds group permissions only.
    await expect(
      c.s.clubRoles.createRole(club.ctx, {
        scope: "group",
        names: { sv: "Fel" },
        permissions: ["club.settings.update"],
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "permission_not_for_group_roles"));

    const coach = await c.s.clubRoles.groupRole(club.ctx, { templateKey: "head_coach" });
    const renamed = await c.s.clubRoles.updateRole(club.ctx, coach.id, {
      version: coach.version,
      names: { sv: "Lagets tränare" },
      permissions: coach.permissions.filter((p) => p !== "person.consents.read"),
    });
    expect(renamed.version).toBe(coach.version + 1);
    expect(renamed.names).toEqual({ sv: "Lagets tränare" });
    // A stale version is refused.
    await expect(
      c.s.clubRoles.updateRole(club.ctx, coach.id, { version: coach.version, names: null }),
    ).rejects.toSatisfy((e) => isDomainError(e, "role_changed"));
    expect(await events(club.id, "role.updated")).toEqual([
      expect.objectContaining({ roleId: coach.id, added: [], removed: ["person.consents.read"] }),
    ]);
    const reset = await c.s.clubRoles.updateRole(club.ctx, coach.id, {
      version: renamed.version,
      resetToTemplate: true,
    });
    expect(reset.names).toBeNull();
    expect([...reset.permissions].sort()).toEqual(
      [...BUILT_IN_ROLE_TEMPLATE.head_coach.permissions].sort(),
    );
  });

  it("previews who loses a permission, counting other roles", async () => {
    const club = await buildClub(c.s);
    const team = await c.s.groups.createGroup(club.ctx, { name: "P2015", kind: "team" });
    const [a, b] = [await buildPerson(c.s), await buildPerson(c.s)];
    for (const p of [a, b]) {
      await c.s.memberships.addMember(club.ctx, p.id);
      await c.s.memberships.addToGroup(club.ctx, team.id, p.id, "head_coach");
    }
    // B also holds the registrar role, which reads consents club-wide.
    await c.s.roles.assignRole(club.ctx, b.id, "registrar");
    const coach = await c.s.clubRoles.groupRole(club.ctx, { templateKey: "head_coach" });
    const preview = await c.s.clubRoles.previewRole(
      club.ctx,
      coach.id,
      coach.permissions.filter((p) => p !== "person.consents.read"),
    );
    expect(preview).toMatchObject({ removed: ["person.consents.read"], holderCount: 2 });
    expect(preview.losing).toEqual([{ permission: "person.consents.read", personIds: [a.id] }]);
  });

  it("assigns club roles, tells others of self-assignment, ends them, and deletes roles", async () => {
    const club = await buildClub(c.s);
    const person = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, person.id);
    const own = await c.s.clubRoles.createRole(club.ctx, {
      scope: "club",
      names: { sv: "Sponsoransvarig" },
      permissions: ["club.members.read"],
    });
    const assignment = await c.s.clubRoles.assignClubRole(club.ctx, person.id, own.id);
    await expect(c.s.clubRoles.assignClubRole(club.ctx, person.id, own.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "role_already_assigned"),
    );
    // The old column gets a stand-in for a club's own role.
    const { rows } = await c.t.query<{ role: string }>(
      "admin",
      "SELECT role FROM public.club_role_assignments WHERE id = $1",
      [assignment.id],
    );
    expect(rows[0]?.role).toBe("staff");

    const treasurer = (await c.s.clubRoles.listRoles(club.ctx)).roles.find(
      (r) => r.templateKey === "treasurer",
    )!;
    await c.s.clubRoles.assignClubRole(club.ctx, club.manager.id, treasurer.id);
    expect(await events(club.id, "role.self_assigned")).toEqual([
      { clubId: club.id, personId: club.manager.id, roleId: treasurer.id },
    ]);
    expect((await c.s.clubRoles.listRoles(club.ctx)).selfAssignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ roleId: treasurer.id })]),
    );

    await c.s.clubRoles.unassign(club.ctx, assignment.id);
    expect(await events(club.id, "role.unassigned")).toEqual([
      { clubId: club.id, personId: person.id, roleId: own.id },
    ]);

    // Deleting with a replacement moves the holders; without one ends them.
    const second = await c.s.clubRoles.assignClubRole(club.ctx, person.id, own.id);
    void second;
    const replacement = await c.s.clubRoles.createRole(club.ctx, {
      scope: "club",
      names: { sv: "Partneransvarig" },
      permissions: [],
    });
    expect(await c.s.clubRoles.deleteRole(club.ctx, own.id, replacement.id)).toEqual({
      moved: 1,
      ended: 0,
    });
    expect(
      (await c.s.clubRoles.assignmentsOfPerson(club.ctx, person.id)).map((a) => a.roleId),
    ).toEqual([replacement.id]);
    await expect(c.s.clubRoles.getRole(club.ctx, own.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "not_found"),
    );
  });

  it("a club's own group role takes part or leads by its permissions", async () => {
    const club = await buildClub(c.s);
    const team = await c.s.groups.createGroup(club.ctx, { name: "Herr", kind: "team" });
    const person = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, person.id);
    const equipment = await c.s.clubRoles.createRole(club.ctx, {
      scope: "group",
      names: { sv: "Materialansvarig" },
      permissions: ["group.activities.manage"],
    });
    const row = await c.s.memberships.addGroupMember(club.ctx, team.id, person.id, "member", {
      role: { id: equipment.id, participates: false },
    });
    const { rows } = await c.t.query<{
      function: string;
      participates: boolean;
      leads: boolean;
      role_id: string;
    }>(
      "admin",
      "SELECT function, participates, leads, role_id FROM public.group_memberships WHERE id = $1",
      [row.id],
    );
    expect(rows[0]).toEqual({
      function: "other_leader",
      participates: false,
      leads: false,
      role_id: equipment.id,
    });
    // Giving the role "counts as a leader" updates its memberships.
    await c.s.clubRoles.updateRole(club.ctx, equipment.id, {
      version: equipment.version,
      permissions: ["group.activities.manage", "group.lead"],
    });
    const after = await c.t.query<{ leads: boolean }>(
      "admin",
      "SELECT leads FROM public.group_memberships WHERE id = $1",
      [row.id],
    );
    expect(after.rows[0]?.leads).toBe(true);
  });

  it("refuses a club role in a group and a group role in the club", async () => {
    const club = await buildClub(c.s);
    const person = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, person.id);
    const groupRole = await c.s.clubRoles.groupRole(club.ctx, { templateKey: "member" });
    await expect(c.s.clubRoles.assignClubRole(club.ctx, person.id, groupRole.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "not_found"),
    );
    // The database refuses it for every writer.
    await expect(
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(sql`
          INSERT INTO public.club_role_assignments (club_id, person_id, role_id, role)
          VALUES (${club.id}, ${person.id}, ${groupRole.id}, 'staff')`),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
