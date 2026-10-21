// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@clubadmin/db";
import { expectTenantIsolation, type TestSession } from "@clubadmin/db/testing";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

/** A connection as the app role inside a club context, with an open transaction. */
async function appSession(clubId: string, personId: string) {
  const client = await c.t.connect("app");
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.club_id', $1, true), set_config('app.person_id', $2, true), set_config('app.actor_kind', 'person', true)",
    [clubId, personId],
  );
  return client;
}

async function clubWithTwoManagers() {
  const club = await buildClub(c.s);
  const second = await buildPerson(c.s);
  await c.s.memberships.addMember(club.ctx, second.id);
  await c.s.roles.assignRole(club.ctx, second.id, "club_manager");
  return { club, first: club.manager, second };
}

describe("club roles", () => {
  it("assigns and ends roles, refusing duplicates", async () => {
    const club = await buildClub(c.s);
    const treasurer = await buildPerson(c.s);
    await c.s.roles.assignRole(club.ctx, treasurer.id, "treasurer");
    await expect(c.s.roles.assignRole(club.ctx, treasurer.id, "treasurer")).rejects.toSatisfy((e) =>
      isDomainError(e, "role_already_assigned"),
    );
    await c.s.roles.endRole(club.ctx, treasurer.id, "treasurer");
    await c.s.roles.assignRole(club.ctx, treasurer.id, "treasurer");
    const { rows } = await c.t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM club_role_assignments WHERE person_id = $1",
      [treasurer.id],
    );
    expect(rows[0]?.n).toBe(2);
  });
});

describe("at least one active club manager", () => {
  it("the service refuses to end the last manager", async () => {
    const club = await buildClub(c.s);
    await expect(c.s.roles.endRole(club.ctx, club.manager.id, "club_manager")).rejects.toSatisfy(
      (e) => isDomainError(e, "last_club_manager"),
    );
    await expect(c.s.memberships.leaveClub(club.ctx, club.manager.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "last_club_manager"),
    );
    expect(await c.s.roles.activeManagers(club.ctx)).toEqual([club.manager.id]);
  });

  it("the database trigger refuses it too, at commit", async () => {
    const club = await buildClub(c.s);
    const client = await appSession(club.id, club.manager.id);
    try {
      await client.query(
        "UPDATE club_role_assignments SET valid_to = now() WHERE club_id = $1 AND role = 'club_manager'",
        [club.id],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        constraint: "club_has_manager",
      });
    } finally {
      await client.end();
    }
    await expect(
      c.t.db.withTenant(club.ctx, (tx) =>
        tx.execute(sql`DELETE FROM club_role_assignments WHERE club_id = ${club.id}`),
      ),
    ).rejects.toMatchObject({ code: "42501" }); // the app role cannot delete role history at all
    expect(await c.s.roles.activeManagers(club.ctx)).toEqual([club.manager.id]);
  });

  it("two managers ending each other at the same time cannot both succeed (trigger)", async () => {
    const { club, first, second } = await clubWithTwoManagers();
    const a = await appSession(club.id, first.id);
    const b = await appSession(club.id, second.id);
    try {
      const end = (client: TestSession, personId: string) =>
        client.query(
          "UPDATE club_role_assignments SET valid_to = now() WHERE club_id = $1 AND person_id = $2 AND role = 'club_manager'",
          [club.id, personId],
        );
      await end(a, second.id);
      await end(b, first.id);
      const results = await Promise.allSettled([a.query("COMMIT"), b.query("COMMIT")]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    expect(await c.s.roles.activeManagers(club.ctx)).toHaveLength(1);
  });

  it("two managers ending each other through the service cannot both succeed", async () => {
    const { club, first, second } = await clubWithTwoManagers();
    const results = await Promise.allSettled([
      c.s.roles.endRole(actor(first.id, club.id), second.id, "club_manager"),
      c.s.roles.endRole(actor(second.id, club.id), first.id, "club_manager"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(isDomainError(rejected?.reason, "last_club_manager")).toBe(true);
    expect(await c.s.roles.activeManagers(club.ctx)).toHaveLength(1);
  });
});

describe("manager hand-over", () => {
  it("after accept, exactly the new manager is active", async () => {
    const club = await buildClub(c.s);
    const successor = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, successor.id);
    const handover = await c.s.roles.proposeHandover(club.ctx, successor.id);
    expect(await c.s.roles.activeManagers(club.ctx)).toEqual([club.manager.id]);

    await c.s.roles.acceptHandover(actor(successor.id, club.id), handover.id);
    expect(await c.s.roles.activeManagers(club.ctx)).toEqual([successor.id]);
  });

  it("concurrent accepts: one succeeds, the rest find the hand-over closed", async () => {
    const club = await buildClub(c.s);
    const successor = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, successor.id);
    const handover = await c.s.roles.proposeHandover(club.ctx, successor.id);
    const ctx = actor(successor.id, club.id);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => c.s.roles.acceptHandover(ctx, handover.id)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(isDomainError(r.reason, "handover_invalid")).toBe(true);
    }
    expect(await c.s.roles.activeManagers(club.ctx)).toEqual([successor.id]);
  });

  it("a new proposal replaces the open one; a stepped-down proposer's hand-over is void", async () => {
    const { club, first, second } = await clubWithTwoManagers();
    const x = await buildPerson(c.s);
    const y = await buildPerson(c.s);
    const toX = await c.s.roles.proposeHandover(actor(first.id, club.id), x.id);
    const toY = await c.s.roles.proposeHandover(actor(first.id, club.id), y.id);
    await expect(c.s.roles.acceptHandover(actor(x.id, club.id), toX.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "handover_invalid"),
    );
    // first is removed as manager by the other manager before y accepts.
    await c.s.roles.endRole(actor(second.id, club.id), first.id, "club_manager");
    await expect(c.s.roles.acceptHandover(actor(y.id, club.id), toY.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "handover_invalid"),
    );
    expect(await c.s.roles.activeManagers(club.ctx)).toEqual([second.id]);
  });

  it("only managers propose; only the successor accepts or declines", async () => {
    const club = await buildClub(c.s);
    const member = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, member.id);
    await expect(c.s.roles.proposeHandover(actor(member.id, club.id), member.id)).rejects.toSatisfy(
      (e) => isDomainError(e, "handover_invalid"),
    );
    const outsider = await buildPerson(c.s);
    await expect(
      c.s.roles.proposeHandover(actor(member.id, club.id), outsider.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_a_club_manager"));
    const handover = await c.s.roles.proposeHandover(club.ctx, member.id);
    await expect(
      c.s.roles.acceptHandover(actor(outsider.id, club.id), handover.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "not_found"));
    await c.s.roles.declineHandover(actor(member.id, club.id), handover.id);
    await expect(
      c.s.roles.acceptHandover(actor(member.id, club.id), handover.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "handover_invalid"));
  });

  it("hand-overs and role assignments are isolated from other clubs", async () => {
    const club = await buildClub(c.s);
    const other = await buildClub(c.s);
    const successor = await buildPerson(c.s);
    await c.s.roles.proposeHandover(club.ctx, successor.id);
    for (const table of ["club_manager_handovers", "club_role_assignments"]) {
      await expectTenantIsolation(c.t.db, other.id, (tx) =>
        tx.execute(sql`SELECT id FROM ${sql.raw(table)} WHERE club_id = ${club.id}`),
      );
    }
  });
});
