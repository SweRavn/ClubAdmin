// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles, part A1 (P1.15, ADR 0046), in the database: the
// built-in template in SQL is the one in @clubadmin/shared, every club gets
// it, assignments point at their roles, group memberships carry whether
// they take part and lead, and app.holds_permission answers for the caller.

import { sql } from "@clubadmin/db";
import { expectTenantIsolation } from "@clubadmin/db/testing";
import { BUILT_IN_ROLE_TEMPLATE } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import { loadRelationshipSet } from "./authorization.repository.ts";

const c = useCoreDatabase();

const templateRows = () =>
  Object.entries(BUILT_IN_ROLE_TEMPLATE)
    .flatMap(([key, t]) =>
      t.permissions.length === 0
        ? [`${t.scope}:${key}:`]
        : t.permissions.map((p) => `${t.scope}:${key}:${p}`),
    )
    .sort();

describe("roles (P1.15 A1)", () => {
  it("the database's built-in template is the shared one", async () => {
    const { rows } = await c.t.query<{ row: string }>(
      "owner",
      `SELECT scope || ':' || template_key || ':' || coalesce(permission, '') AS row
       FROM app.builtin_role_template()`,
    );
    expect(rows.map((r) => r.row).sort()).toEqual(templateRows());
  });

  it("a new club gets the template's roles; the club manager's and chair's are locked", async () => {
    const club = await buildClub(c.s);
    const rows = await c.t.db.withTenant(club.ctx, async (tx) => {
      const { rows } = await tx.execute<{ row: string; locked: boolean }>(sql`
        SELECT r.scope || ':' || r.template_key || ':' || coalesce(rp.permission, '') AS row,
          r.locked
        FROM public.roles r LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
        WHERE r.club_id = ${club.id}`);
      return rows;
    });
    expect(rows.map((r) => r.row).sort()).toEqual(templateRows());
    const locked = new Set(rows.filter((r) => r.locked).map((r) => r.row.split(":")[1]));
    expect([...locked].sort()).toEqual(["chair", "club_manager"]);
  });

  it("assignments point at their role; memberships take part or lead by their role", async () => {
    const club = await buildClub(c.s);
    const team = await c.s.groups.createGroup(club.ctx, { name: "P2015", kind: "team" });
    const player = await buildPerson(c.s);
    const coach = await buildPerson(c.s);
    for (const p of [player, coach]) await c.s.memberships.addMember(club.ctx, p.id);
    await c.s.memberships.addGroupMember(club.ctx, team.id, player.id, "member");
    await c.s.memberships.addGroupMember(club.ctx, team.id, coach.id, "head_coach");
    await c.s.roles.assignRole(club.ctx, coach.id, "registrar");

    const rows = await c.t.db.withTenant(club.ctx, async (tx) => {
      const { rows } = await tx.execute<{
        person_id: string;
        template_key: string;
        participates: boolean;
        leads: boolean;
      }>(sql`
        SELECT gm.person_id, r.template_key, gm.participates, gm.leads
        FROM public.group_memberships gm JOIN public.roles r ON r.id = gm.role_id
        WHERE gm.group_id = ${team.id}`);
      return rows;
    });
    expect(rows.find((r) => r.person_id === player.id)).toMatchObject({
      template_key: "member",
      participates: true,
      leads: false,
    });
    expect(rows.find((r) => r.person_id === coach.id)).toMatchObject({
      template_key: "head_coach",
      participates: false,
      leads: true,
    });

    // The relationship set carries the roles' permissions.
    const set = await c.t.db.withActor(actor(coach.id), (tx) => loadRelationshipSet(tx, coach.id));
    const registrar = set.roles.find((r) => r.clubId === club.id && r.role === "registrar");
    expect(registrar?.roleId).toBeTruthy();
    expect([...(registrar?.permissions ?? [])].sort()).toEqual(
      [...BUILT_IN_ROLE_TEMPLATE.registrar.permissions].sort(),
    );
    expect(set.groups.find((g) => g.groupId === team.id)?.permissions).toContain(
      "group.activities.manage",
    );

    // app.holds_permission: club roles in the club, group roles in their group.
    const holds = (personId: string, permission: string, groupId: string | null = null) =>
      c.t.db.withTenant(actor(personId, club.id), async (tx) => {
        const { rows } = await tx.execute<{ ok: boolean }>(
          sql`SELECT app.holds_permission(${club.id}, ${permission}, ${groupId}::uuid) AS ok`,
        );
        return rows[0]?.ok;
      });
    expect(await holds(coach.id, "club.members.import")).toBe(true);
    expect(await holds(coach.id, "club.settings.update")).toBe(false);
    expect(await holds(coach.id, "group.activities.manage")).toBe(false);
    expect(await holds(coach.id, "group.activities.manage", team.id)).toBe(true);
    expect(await holds(player.id, "group.activities.manage", team.id)).toBe(false);
    expect(await holds(player.id, "group.participate", team.id)).toBe(true);
    expect(await holds(club.manager.id, "group.activities.manage", team.id)).toBe(true);
  });

  it("another club sees none of a club's roles", async () => {
    const club = await buildClub(c.s);
    const other = await buildClub(c.s);
    await expectTenantIsolation(c.t.db, other.id, (tx) =>
      tx.execute(sql`SELECT * FROM public.roles WHERE club_id = ${club.id}`),
    );
    await expectTenantIsolation(c.t.db, other.id, (tx) =>
      tx.execute(sql`SELECT * FROM public.role_permissions WHERE club_id = ${club.id}`),
    );
  });
});
