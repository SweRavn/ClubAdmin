// SPDX-License-Identifier: AGPL-3.0-only
// Club types and their templates (P1.15 B, ADR 0046): operators create a type
// (it starts with the required roles), add and change roles; the required
// roles keep their permissions; a new club of the type gets its roles, and a
// type's own keys work with the old role and function columns; the roles
// page compares with the template, copies from it (restoring a deleted
// role) and resets to it; creation requests keep the chosen type.

import { BUILT_IN_CLUB_TYPE, type ClubTypeNames } from "@clubadmin/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import type { ClubTypeRow } from "./club-types.service.ts";

const c = useCoreDatabase();

const names = (sv: string): ClubTypeNames => ({ sv, en: `${sv} (en)`, nb: `${sv} (nb)` });
let operator: { actorKind: "operator"; personId: string; requestId: string };
let chess: ClubTypeRow;

const rejects = (code: string) => (e: unknown) => isDomainError(e, code as never);

beforeAll(async () => {
  const person = await buildPerson(c.s);
  await c.t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [person.id]);
  operator = { actorKind: "operator", personId: person.id, requestId: "test-club-types" };
  chess = await c.s.clubTypes.createType(operator, {
    key: `chess_${Date.now()}`,
    names: names("Schackklubb"),
  });
  chess = await c.s.clubTypes.createRole(operator, chess.id, {
    key: "tournament_director",
    scope: "club",
    names: names("Turneringsledare"),
    permissions: ["club.events.create", "event.read"],
  });
  chess = await c.s.clubTypes.createRole(operator, chess.id, {
    key: "arbiter",
    scope: "group",
    names: names("Domare"),
    permissions: ["group.lead"],
  });
  const member = chess.roles.find((r) => r.key === "member")!;
  chess = await c.s.clubTypes.updateRole(operator, chess.id, member.id, {
    names: names("Spelare"),
  });
});

describe("club types (operators)", () => {
  it("a new type starts with the required roles and keeps them", async () => {
    expect(chess.roles.map((r) => `${r.scope}:${r.key}`).sort()).toEqual([
      "club:chair",
      "club:club_manager",
      "club:tournament_director",
      "group:arbiter",
      "group:member",
    ]);
    const manager = chess.roles.find((r) => r.key === "club_manager")!;
    expect(manager.locked).toBe(true);
    expect(manager.permissions).toContain("club.roles.manage");
    await expect(
      c.s.clubTypes.updateRole(operator, chess.id, manager.id, {
        permissions: ["club.members.read"],
      }),
    ).rejects.toSatisfy(rejects("club_type_role_required"));
    await expect(c.s.clubTypes.deleteRole(operator, chess.id, manager.id)).rejects.toSatisfy(
      rejects("club_type_role_required"),
    );
    // A key the catalogue does not know needs names; a group role holds group permissions only.
    await expect(
      c.s.clubTypes.createRole(operator, chess.id, {
        key: "kibitzer",
        scope: "group",
        permissions: [],
      }),
    ).rejects.toSatisfy(rejects("club_type_role_names_required"));
    await expect(
      c.s.clubTypes.createRole(operator, chess.id, {
        key: "kibitzer",
        scope: "group",
        names: names("Kibitz"),
        permissions: ["club.members.read"],
      }),
    ).rejects.toSatisfy(rejects("permission_not_for_group_roles"));
    await expect(
      c.s.clubTypes.createType(operator, { key: chess.key, names: names("Igen") }),
    ).rejects.toSatisfy(rejects("club_type_exists"));
  });

  it("the built-in type stays active; an inactive type cannot be chosen", async () => {
    const all = await c.s.clubTypes.allTypes(operator);
    const builtIn = all.find((t) => t.key === BUILT_IN_CLUB_TYPE)!;
    await expect(
      c.s.clubTypes.updateType(operator, builtIn.id, { active: false }),
    ).rejects.toSatisfy(rejects("club_type_built_in"));
    const retired = await c.s.clubTypes.createType(operator, {
      key: `retired_${Date.now()}`,
      names: names("Gammal"),
    });
    await c.s.clubTypes.updateType(operator, retired.id, { active: false });
    const person = await buildPerson(c.s);
    expect((await c.s.clubTypes.activeTypes(actor(person.id))).map((t) => t.id)).not.toContain(
      retired.id,
    );
    await expect(buildClub(c.s, { clubTypeId: retired.id })).rejects.toSatisfy(
      rejects("club_type_unavailable"),
    );
  });
});

describe("a club of the type", () => {
  it("gets the type's roles; its own keys work with the old columns", async () => {
    const club = await buildClub(c.s, { clubTypeId: chess.id, registrar: false });
    const roles = await c.s.clubRoles.rolesOfClub(club.ctx);
    const director = roles.find((r) => r.templateKey === "tournament_director")!;
    expect(director.names).toEqual(names("Turneringsledare"));
    expect(roles.find((r) => r.templateKey === "member")?.names).toEqual(names("Spelare"));
    // No registrar in a chess club: only the type's roles.
    expect(roles.some((r) => r.templateKey === "registrar")).toBe(false);

    const person = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, person.id);
    await c.s.clubRoles.assignClubRole(club.ctx, person.id, director.id);
    const group = await c.s.groups.createGroup(club.ctx, { name: "Elit", kind: "team" });
    // By function name (older writers) the participant role; by ID the type's own key.
    await c.s.memberships.addToGroup(club.ctx, group.id, person.id);
    const arbiter = roles.find((r) => r.templateKey === "arbiter")!;
    const second = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, second.id);
    await c.t.db.withTenant(club.ctx, (tx) =>
      c.s.memberships.addToGroupInTx(tx, club.ctx, group.id, second.id, "member", {
        roleId: arbiter.id,
      }),
    );
    const { rows } = await c.t.query<{ role: string }>(
      "admin",
      "SELECT role FROM club_role_assignments WHERE club_id = $1 AND person_id = $2",
      [club.id, person.id],
    );
    expect(rows).toEqual([{ role: "staff" }]);
    const { rows: functions } = await c.t.query<{
      person_id: string;
      function: string;
      leads: boolean;
    }>(
      "admin",
      "SELECT person_id, function, leads FROM group_memberships WHERE group_id = $1 ORDER BY function",
      [group.id],
    );
    expect(functions).toEqual([
      { person_id: person.id, function: "member", leads: false },
      { person_id: second.id, function: "other_leader", leads: true },
    ]);
  });

  it("compares with the template, copies from it, restores a deleted role and resets", async () => {
    const club = await buildClub(c.s, { clubTypeId: chess.id, registrar: false });
    const list = async () => c.s.clubRoles.listRoles(club.ctx);
    let roles = await list();
    expect(roles.clubType?.id).toBe(chess.id);
    expect(roles.templateRoles.every((t) => t.status === "present")).toBe(true);

    // The operator adds a role to the template later: the club does not get it by itself.
    const withTreasurer = await c.s.clubTypes.createRole(operator, chess.id, {
      key: "treasurer",
      scope: "club",
      permissions: ["billing.invoices.read"],
    });
    expect(withTreasurer.roles.some((r) => r.key === "treasurer")).toBe(true);
    roles = await list();
    expect(roles.templateRoles.find((t) => t.key === "treasurer")?.status).toBe("missing");
    const copied = await c.s.clubRoles.copyFromTemplate(club.ctx, {
      scope: "club",
      key: "treasurer",
    });
    expect(copied.templateKey).toBe("treasurer");
    expect(copied.permissions).toEqual(["billing.invoices.read"]);
    await expect(
      c.s.clubRoles.copyFromTemplate(club.ctx, { scope: "club", key: "treasurer" }),
    ).rejects.toSatisfy(rejects("template_role_exists"));

    // Deleted (archived), then copied again: the same role comes back.
    const director = roles.roles.find((r) => r.templateKey === "tournament_director")!;
    await c.s.clubRoles.deleteRole(club.ctx, director.id, undefined);
    expect((await list()).templateRoles.find((t) => t.key === "tournament_director")?.status).toBe(
      "archived",
    );
    const restored = await c.s.clubRoles.copyFromTemplate(club.ctx, {
      scope: "club",
      key: "tournament_director",
    });
    expect(restored.id).toBe(director.id);
    expect(restored.names).toEqual(names("Turneringsledare"));

    // Changed in the club, then reset: the type's permissions and names.
    const changed = await c.s.clubRoles.updateRole(club.ctx, restored.id, {
      version: restored.version,
      names: { sv: "Tävlingsledare" },
      permissions: ["event.read"],
    });
    roles = await list();
    expect(roles.templates.get(changed.id)).toEqual(["club.events.create", "event.read"]);
    const reset = await c.s.clubRoles.updateRole(club.ctx, changed.id, {
      version: changed.version,
      resetToTemplate: true,
    });
    expect([...reset.permissions].sort()).toEqual(["club.events.create", "event.read"]);
    expect(reset.names).toEqual(names("Turneringsledare"));
  });

  it("a creation request keeps the chosen type for the operator's approval", async () => {
    const founder = await buildPerson(c.s);
    const result = await c.s.onboarding.createOrRequest(
      actor(founder.id),
      { name: "Ekudden SK", slug: `ekudden-${Date.now()}`, country: "SE", clubTypeId: chess.id },
      { mode: "approval", operator: false },
    );
    if (!("request" in result)) throw new Error("expected a request");
    expect(result.request.clubTypeId).toBe(chess.id);
    const decided = await c.s.onboarding.decideCreation(operator, result.request.id, {
      decision: "approve",
    });
    const { rows } = await c.t.query<{ club_type_id: string }>(
      "admin",
      "SELECT club_type_id FROM clubs WHERE id = $1",
      [decided.createdClubId],
    );
    expect(rows[0]?.club_type_id).toBe(chess.id);
  });
});
