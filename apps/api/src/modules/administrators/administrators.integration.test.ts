// SPDX-License-Identifier: AGPL-3.0-only
// At least two administrators; suspending one (P1.15 A3, ADR 0046): who
// counts, the club that needs administrators adds no members, the database
// refuses fewer than two (and the application cannot set the exception),
// the two-person rule, and the second administrator invited at creation.

import { isCheckViolation } from "@clubadmin/db";
import { emailInvitationToken } from "@clubadmin/server-kit/invitations";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson, type BuiltClub } from "../../testing/builders.ts";
import { useCoreDatabase } from "../../testing/core.ts";
import { TEST_INVITATION_TOKEN_KEY } from "../../testing/services.ts";

const c = useCoreDatabase();

/** A club without a grace period and `extra` more club managers (each a member). */
async function clubWithAdministrators(extra: number) {
  const club = await buildClub(c.s, { administratorsGrace: false });
  const others = [];
  for (let i = 0; i < extra; i++) {
    const person = await buildPerson(c.s);
    await c.t.db.withTenant(club.ctx, (tx) =>
      c.s.memberships.addMemberInTx(tx, club.ctx, person.id, undefined, { administrator: true }),
    );
    await c.s.roles.assignRole(club.ctx, person.id, "club_manager");
    others.push(person);
  }
  return { club, others };
}

async function outboxTypes(clubId: string): Promise<string[]> {
  const { rows } = await c.t.query<{ type: string }>(
    "admin",
    "SELECT type FROM outbox.events WHERE club_id = $1 ORDER BY created_at, id",
    [clubId],
  );
  return rows.map((r) => r.type);
}

const overview = (club: BuiltClub) => c.s.administrators.overview(club.ctx);

describe("who counts (A3.1)", () => {
  it("club.roles.manage through any role; adults with an account; distinct people", async () => {
    const { club, others } = await clubWithAdministrators(1);
    const [second] = others;
    // A club role of its own with club.roles.manage, held by the second as well.
    const own = await c.s.clubRoles.createRole(club.ctx, {
      scope: "club",
      names: { sv: "Kansli" },
      permissions: ["club.roles.manage"],
    });
    await c.s.clubRoles.assignClubRole(club.ctx, second!.id, own.id);
    // A minor and a person without an account hold it too, and do not count.
    const minor = await buildPerson(c.s, { birthDate: "2012-01-01" });
    const noLogin = await buildPerson(c.s, { email: null });
    for (const p of [minor, noLogin]) {
      await c.s.memberships.addMember(club.ctx, p.id);
      await c.s.clubRoles.assignClubRole(club.ctx, p.id, own.id);
    }
    const facts = await overview(club);
    expect(facts.count).toBe(2);
    expect(facts.state).toBe("recommend_third");
    const byPerson = new Map(facts.administrators.map((a) => [a.personId, a]));
    expect(byPerson.get(second!.id)).toMatchObject({ counts: true, reason: null });
    expect(byPerson.get(second!.id)!.roleIds).toHaveLength(2);
    expect(byPerson.get(minor.id)).toMatchObject({ counts: false, reason: "minor" });
    expect(byPerson.get(noLogin.id)).toMatchObject({ counts: false, reason: "no_account" });
  });
});

describe("minimum two (A3.2)", () => {
  it("a club with one administrator and no grace period adds no members", async () => {
    const club = await buildClub(c.s, { administratorsGrace: false });
    expect((await overview(club)).state).toBe("needs_administrators");
    const person = await buildPerson(c.s);
    await expect(c.s.memberships.addMember(club.ctx, person.id)).rejects.toSatisfy((e) =>
      isDomainError(e, "club_needs_administrators"),
    );
    // Within a grace period it can.
    const graced = await buildClub(c.s);
    expect((await overview(graced)).state).toBe("grace");
    await c.s.memberships.addMember(graced.ctx, person.id);
  });

  it("an invitation to the club manager role brings the second administrator in", async () => {
    const club = await buildClub(c.s, { administratorsGrace: false });
    const invitee = await buildPerson(c.s);
    const { invitation } = await c.s.invitations.create(
      club.ctx,
      { kind: "email", email: invitee.email!, rolePreset: "club_manager", expiresInDays: 7 },
      { mayPresetRole: true, mfa: true },
    );
    await c.s.invitations.accept(actor(invitee.id), {
      token: emailInvitationToken(TEST_INVITATION_TOKEN_KEY, invitation.id),
    });
    expect(await overview(club)).toMatchObject({ count: 2, state: "recommend_third" });
    // Now the club adds members, and every administrator was told of the new one.
    await c.s.memberships.addMember(club.ctx, (await buildPerson(c.s)).id);
    expect(await outboxTypes(club.id)).toContain("administrator.added");
  });

  it("a new club asks for its second administrator: invited with the club", async () => {
    const founder = await buildPerson(c.s);
    const club = await c.s.onboarding.createClub(actor(founder.id), {
      name: "Nya IF",
      slug: `nya-if-${founder.id.slice(-8)}`,
      country: "SE",
      secondAdministratorEmail: "second@example.test",
    });
    const { rows } = await c.t.query<{ email: string; role_preset: string }>(
      "admin",
      "SELECT email, role_preset FROM invitations WHERE club_id = $1",
      [club.id],
    );
    expect(rows).toEqual([{ email: "second@example.test", role_preset: "club_manager" }]);
  });

  it("the database refuses fewer than two outside a suspension or erasure", async () => {
    const { club, others } = await clubWithAdministrators(1);
    await expect(c.s.roles.endRole(club.ctx, others[0]!.id, "club_manager")).rejects.toSatisfy(
      (e) => isCheckViolation(e, "club_administrators_minimum"),
    );
    // A one-to-one hand-over keeps the count and is allowed.
    const successor = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, successor.id);
    const handover = await c.s.roles.proposeHandover(club.ctx, successor.id);
    await c.s.roles.acceptHandover(actor(successor.id, club.id), handover.id);
    expect((await overview(club)).count).toBe(2);
  });

  it("the application role cannot set the exception", async () => {
    const { club } = await clubWithAdministrators(1);
    const app = await c.t.connect("app");
    try {
      await app.query("BEGIN");
      await app.query(
        "SELECT set_config('app.club_id', $1, true), set_config('app.actor_kind', 'system_job', true)",
        [club.id],
      );
      await expect(
        app.query(
          "INSERT INTO app.administrator_minimum_exceptions (txid, club_id, reason) VALUES (pg_current_xact_id(), $1, 'suspension')",
          [club.id],
        ),
      ).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await expect(
        app.query("SELECT app.allow_fewer_administrators($1, 'suspension')", [club.id]),
      ).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
      // The erasure's function sets it only for a person in a running erasure.
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.actor_kind', 'system_job', true)");
      const { rows } = await app.query<{ allowed: boolean }>(
        "SELECT app.allow_fewer_administrators_for_erasure($1, $2) AS allowed",
        [club.id, club.manager.id],
      );
      expect(rows[0]?.allowed).toBe(false);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });
});

describe("suspending an administrator (A3.4)", () => {
  it("two administrators suspend a third; the target loses every role and invitation", async () => {
    const { club, others } = await clubWithAdministrators(2);
    const [b, target] = others;
    const a = club.manager;
    // The target leads a team, proposed a hand-over and invited someone with a role.
    const team = await c.s.groups.createGroup(club.ctx, { name: "P2015", kind: "team" });
    await c.s.memberships.addToGroup(club.ctx, team.id, target!.id, "head_coach");
    const successor = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, successor.id);
    await c.s.roles.proposeHandover(actor(target!.id, club.id), successor.id);
    await c.s.invitations.create(
      actor(target!.id, club.id),
      { kind: "email", email: "x@example.test", rolePreset: "treasurer", expiresInDays: 7 },
      { mayPresetRole: true, mfa: true },
    );

    const request = await c.s.administrators.start(actor(a.id, club.id), target!.id, {
      reason: "compromised",
    });
    expect(request).toMatchObject({ status: "requested", demote: true });
    await expect(
      c.s.administrators.start(actor(b!.id, club.id), target!.id, { reason: "other" }),
    ).rejects.toSatisfy((e) => isDomainError(e, "suspension_requested"));
    // Neither the initiator nor the target confirms.
    for (const who of [a.id, target!.id]) {
      await expect(c.s.administrators.confirm(actor(who, club.id), request.id)).rejects.toSatisfy(
        (e) => isDomainError(e, "suspension_not_allowed"),
      );
    }
    const result = await c.s.administrators.confirm(actor(b!.id, club.id), request.id);
    expect(result).toMatchObject({ endedRoles: 1, endedGroupRoles: 1 });
    expect(result.suspension).toMatchObject({ status: "confirmed", confirmedByPersonId: b!.id });

    const facts = await overview(club);
    expect(facts.count).toBe(2);
    expect(facts.administrators.map((x) => x.personId)).not.toContain(target!.id);
    const { rows } = await c.t.query<{ handovers: number; invitations: number; leads: number }>(
      "admin",
      `SELECT
         (SELECT count(*)::int FROM club_manager_handovers
          WHERE club_id = $1 AND status = 'proposed') AS handovers,
         (SELECT count(*)::int FROM invitations
          WHERE club_id = $1 AND created_by_person_id = $2 AND revoked_at IS NULL) AS invitations,
         (SELECT count(*)::int FROM group_memberships
          WHERE club_id = $1 AND person_id = $2 AND valid_to IS NULL) AS leads`,
      [club.id, target!.id],
    );
    expect(rows[0]).toEqual({ handovers: 0, invitations: 0, leads: 0 });
    // Still a member of the club.
    expect(
      await c.t.db.withTenant(club.ctx, (tx) =>
        c.s.memberships.hasOpenMembershipInTx(tx, club.id, target!.id),
      ),
    ).toBe(true);
    expect(await outboxTypes(club.id)).toEqual(
      expect.arrayContaining(["administrator.suspension.requested", "administrator.suspended"]),
    );
    const { rows: audit } = await c.t.query<{ action: string }>(
      "admin",
      "SELECT action FROM audit.events WHERE club_id = $1 AND action LIKE 'administrator.%'",
      [club.id],
    );
    expect(audit.map((r) => r.action).sort()).toEqual([
      "administrator.suspended",
      "administrator.suspension.requested",
    ]);
  });

  it("with two administrators the chair confirms; the club then needs an administrator", async () => {
    const { club, others } = await clubWithAdministrators(1);
    const chair = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, chair.id);
    await c.s.roles.assignRole(club.ctx, chair.id, "chair");
    const request = await c.s.administrators.start(club.ctx, others[0]!.id, {
      reason: "left_task",
    });
    expect(request.demote).toBe(false);
    await c.s.administrators.confirm(actor(chair.id, club.id), request.id);
    expect(await overview(club)).toMatchObject({ count: 1, state: "needs_administrators" });
  });

  it("the initiator cancels; nobody else can", async () => {
    const { club, others } = await clubWithAdministrators(2);
    const request = await c.s.administrators.start(club.ctx, others[1]!.id, { reason: "other" });
    await expect(
      c.s.administrators.cancel(actor(others[0]!.id, club.id), request.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "suspension_not_allowed"));
    const cancelled = await c.s.administrators.cancel(club.ctx, request.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(
      c.s.administrators.confirm(actor(others[0]!.id, club.id), request.id),
    ).rejects.toSatisfy((e) => isDomainError(e, "suspension_not_open"));
  });

  it("an operator extends a grace period once", async () => {
    const club = await buildClub(c.s);
    const operator = await buildPerson(c.s);
    await c.t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [
      operator.id,
    ]);
    const before = (await overview(club)).graceUntil!;
    const extended = await c.s.administrators.extendGrace(actor(operator.id, club.id));
    expect(extended.getTime()).toBeGreaterThan(before.getTime() + 29 * 86_400_000);
    await expect(c.s.administrators.extendGrace(actor(operator.id, club.id))).rejects.toSatisfy(
      (e) => isDomainError(e, "grace_already_extended"),
    );
  });
});
