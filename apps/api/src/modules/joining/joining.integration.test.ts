// SPDX-License-Identifier: AGPL-3.0-only
// Sign-up to club membership through the HTTP API (P1.1, ADR 0018): profile
// completion, club search, join requests, invitations, club creation in all
// three CLUB_CREATION modes, and club managers.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { emailInvitationToken } from "@clubadmin/server-kit/invitations";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  actor,
  buildClub,
  buildFamily,
  buildPerson,
  type BuiltClub,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

const TOKEN_KEY = "test-invitation-key-0123456789abcdef";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

const env = (extra: Record<string, string> = {}) => ({
  NODE_ENV: "development",
  DATABASE_URL: t.url("app"),
  DEV_AUTH: "true",
  DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
  INVITATION_TOKEN_KEY: TOKEN_KEY,
  CLUB_CREATION: "open",
  ...NO_RATE_LIMITS,
  ...extra,
});

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db, { invitationTokenKey: TOKEN_KEY });
  app = await createTestApp(env());
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

async function call(
  target: TestApp,
  personId: string | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  options: { body?: unknown; mfa?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (personId) {
    headers.authorization = `Bearer ${await devToken(personId, { mfa: options.mfa ?? false })}`;
  }
  return target.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const api = (
  personId: string | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  options: { body?: unknown; mfa?: boolean } = {},
) => call(app, personId, method, url, options);

const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

describe("profile", () => {
  it("is completed once after sign-up; until then club actions are refused", async () => {
    const club = await buildClub(s);
    const person = await buildPerson(s);
    await t.query("admin", "UPDATE people SET birth_date = NULL WHERE id = $1", [person.id]);

    const before = await api(person.id, "GET", "/me/profile");
    expect(before.json()).toMatchObject({ birthDate: null, complete: false });
    const refused = await api(person.id, "POST", `/clubs/${club.id}/join-requests`, {
      body: { personIds: [person.id] },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toBe("profile_incomplete");

    const tooYoung = await api(person.id, "PUT", "/me/profile", {
      body: { givenName: "Kid", familyName: "Young", birthDate: "2020-01-01" },
    });
    expect(detail(tooYoung)).toBe("too_young_for_account");
    const done = await api(person.id, "PUT", "/me/profile", {
      body: { givenName: "Emma", familyName: "Svensson", birthDate: "1997-05-02" },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({
      person: { id: person.id, displayName: "Emma Svensson" },
      birthDate: "1997-05-02",
      complete: true,
    });
    // The birth date stays; the name can still change here.
    const again = await api(person.id, "PUT", "/me/profile", {
      body: { givenName: "Emma", familyName: "Berg", birthDate: "2001-01-01" },
    });
    expect(again.json()).toMatchObject({ birthDate: "1997-05-02" });
  });
});

describe("club search", () => {
  it("lists active clubs that take requests, never invite-only ones, by name or city", async () => {
    const suffix = Date.now().toString(36);
    const open = await buildClub(s, { name: `Searchable Open ${suffix}`, joinPolicy: "open" });
    const approval = await buildClub(s, { name: `Searchable Approval ${suffix}` });
    await buildClub(s, { name: `Searchable Hidden ${suffix}`, joinPolicy: "invite_only" });
    const person = await buildPerson(s);

    const res = await api(person.id, "GET", `/clubs?q=searchable&limit=50`);
    const names = res.json<{ items: { name: string }[] }>().items.map((c) => c.name);
    expect(names).toContain(open.name);
    expect(names).toContain(approval.name);
    expect(names.some((n) => n.includes("Hidden"))).toBe(false);

    const page = await api(person.id, "GET", `/clubs?q=${suffix}&limit=1`);
    const first = page.json<{ items: { id: string }[]; nextCursor: string }>();
    expect(first.items).toHaveLength(1);
    const second = await api(
      person.id,
      "GET",
      `/clubs?q=${suffix}&limit=1&cursor=${first.nextCursor}`,
    );
    expect(second.json<{ items: { id: string }[] }>().items[0]!.id).not.toBe(first.items[0]!.id);
    expect((await api(null, "GET", "/clubs?q=searchable")).statusCode).toBe(401);
  });
});

describe("join requests", () => {
  it("a guardian applies for themselves and a child; a registrar approves", async () => {
    const club = await buildClub(s);
    const registrar = await buildPerson(s);
    await s.memberships.addMember(club.ctx, registrar.id);
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
    const family = await buildFamily(s);
    const stranger = await buildPerson(s);
    const group = await s.groups.createGroup(club.ctx, { name: "J2014", kind: "team" });

    const notWard = await api(family.guardian.id, "POST", `/clubs/${club.id}/join-requests`, {
      body: { personIds: [stranger.id] },
    });
    expect(notWard.statusCode).toBe(403);
    expect(detail(notWard)).toBe("not_guardian");

    const res = await api(family.guardian.id, "POST", `/clubs/${club.id}/join-requests`, {
      body: {
        personIds: [family.guardian.id, family.child.id],
        message: "We just moved here",
        preferredGroupIds: [group.id],
      },
    });
    expect(res.statusCode).toBe(201);
    const items = res.json<{
      items: { personId: string; result: string; joinRequestId: string }[];
    }>().items;
    expect(items.map((i) => i.result)).toEqual(["pending", "pending"]);
    const duplicate = await api(family.guardian.id, "POST", `/clubs/${club.id}/join-requests`, {
      body: { personIds: [family.child.id] },
    });
    expect(detail(duplicate)).toBe("join_request_exists");

    // The applicants see their requests and the club's name; the club is not "theirs" yet.
    const mine = await api(family.guardian.id, "GET", "/me/join-requests");
    expect(mine.json<{ items: { club: { name: string }; status: string }[] }>().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ club: { id: club.id, name: club.name }, status: "pending" }),
      ]),
    );

    const list = await api(registrar.id, "GET", `/clubs/${club.id}/join-requests`);
    expect(list.statusCode).toBe(200);
    const pending = list.json<{
      items: {
        id: string;
        person: { id: string };
        requestedBy: { id: string } | null;
        preferredGroups: { name: string }[];
      }[];
    }>().items;
    const childRequest = pending.find((r) => r.person.id === family.child.id)!;
    expect(childRequest.requestedBy?.id).toBe(family.guardian.id);
    expect(childRequest.preferredGroups).toEqual([{ id: group.id, name: "J2014" }]);

    const approve = await api(
      registrar.id,
      "POST",
      `/clubs/${club.id}/join-requests/${childRequest.id}/decision`,
      { body: { decision: "approve", message: "Welcome!" } },
    );
    expect(approve.statusCode).toBe(200);
    const { rows } = await t.query<{ status: string }>(
      "admin",
      "SELECT status FROM club_memberships WHERE club_id = $1 AND person_id = $2",
      [club.id, family.child.id],
    );
    expect(rows).toEqual([{ status: "active" }]);
    expect(await auditActionsOf(t, childRequest.id)).toEqual([
      "join_request.created",
      "join_request.approved",
    ]);
    const { rows: events } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'join_request.decided' AND payload ->> 'joinRequestId' = $1",
      [childRequest.id],
    );
    expect(events[0]?.n).toBe(1);
    const decidedAgain = await api(
      registrar.id,
      "POST",
      `/clubs/${club.id}/join-requests/${childRequest.id}/decision`,
      { body: { decision: "reject" } },
    );
    expect(decidedAgain.statusCode).toBe(400);

    // The guardian withdraws their own request; then it is no longer pending.
    const own = items.find((i) => i.personId === family.guardian.id)!;
    const withdraw = await api(
      family.guardian.id,
      "POST",
      `/me/join-requests/${own.joinRequestId}/withdraw`,
    );
    expect(withdraw.statusCode).toBe(200);
    const after = await api(registrar.id, "GET", `/clubs/${club.id}/join-requests`);
    expect(after.json<{ items: unknown[] }>().items).toEqual([]);
    // Someone else cannot withdraw a request.
    const other = await api(stranger.id, "POST", `/me/join-requests/${own.joinRequestId}/withdraw`);
    expect(other.statusCode).toBe(404);
  });

  it("open clubs take applicants at once; invite-only clubs are not found", async () => {
    const open = await buildClub(s, { joinPolicy: "open" });
    const hidden = await buildClub(s, { joinPolicy: "invite_only" });
    const person = await buildPerson(s);
    const joined = await api(person.id, "POST", `/clubs/${open.id}/join-requests`, {
      body: { personIds: [person.id] },
    });
    expect(joined.json()).toEqual({
      items: [{ personId: person.id, result: "member", joinRequestId: null }],
    });
    const refused = await api(person.id, "POST", `/clubs/${hidden.id}/join-requests`, {
      body: { personIds: [person.id] },
    });
    expect(refused.statusCode).toBe(404);
  });
});

describe("invitations", () => {
  let club: BuiltClub;
  let registrar: Awaited<ReturnType<typeof buildPerson>>;

  beforeAll(async () => {
    club = await buildClub(s, { joinPolicy: "invite_only" });
    registrar = await buildPerson(s);
    await s.memberships.addMember(club.ctx, registrar.id);
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
  });

  it("a link with a group preset: look up, accept, use again, revoke", async () => {
    const group = await s.groups.createGroup(club.ctx, { name: "F2017", kind: "team" });
    const created = await api(registrar.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groupId: group.id, maxUses: 5 },
    });
    expect(created.statusCode).toBe(201);
    const { url, invitation } = created.json<{
      url: string;
      invitation: { id: string; state: string };
    }>();
    expect(invitation.state).toBe("active");
    const token = decodeURIComponent(url.split("/join/")[1]!);

    const lookup = await api(null, "GET", `/invitations/lookup?token=${encodeURIComponent(token)}`);
    expect(lookup.json()).toMatchObject({
      clubId: club.id,
      clubName: club.name,
      kind: "link",
      groups: [{ groupId: group.id, groupName: "F2017", role: { templateKey: "member" } }],
      clubRole: null,
    });

    const person = await buildPerson(s);
    const accepted = await api(person.id, "POST", "/invitations/accept", { body: { token } });
    expect(accepted.json()).toEqual({ clubId: club.id, clubName: club.name, alreadyMember: false });
    const again = await api(person.id, "POST", "/invitations/accept", { body: { token } });
    expect(again.json()).toMatchObject({ alreadyMember: true });
    const { rows } = await t.query<{ uses: number; in_group: boolean }>(
      "admin",
      `SELECT i.uses, EXISTS (SELECT 1 FROM group_memberships g WHERE g.group_id = $2 AND g.person_id = $3 AND g.valid_to IS NULL) AS in_group
       FROM invitations i WHERE i.id = $1`,
      [invitation.id, group.id, person.id],
    );
    expect(rows).toEqual([{ uses: 1, in_group: true }]);

    const list = await api(registrar.id, "GET", `/clubs/${club.id}/invitations`);
    expect(JSON.stringify(list.json())).not.toContain(token);

    expect(
      (await api(registrar.id, "POST", `/clubs/${club.id}/invitations/${invitation.id}/revoke`))
        .statusCode,
    ).toBe(200);
    const gone = await api(null, "GET", `/invitations/lookup?token=${encodeURIComponent(token)}`);
    expect(gone.statusCode).toBe(409);
    expect(detail(gone)).toBe("invitation_invalid");
  });

  it("a code works however it is typed; a role preset needs a club manager with MFA", async () => {
    const byRegistrar = await api(registrar.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "code", rolePreset: "treasurer" },
    });
    expect(byRegistrar.statusCode).toBe(403);
    expect(detail(byRegistrar)).toBe("role_preset_not_allowed");
    const withoutMfa = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "code", rolePreset: "treasurer" },
    });
    expect(withoutMfa.statusCode).toBe(403);
    expect(detail(withoutMfa)).toBe("mfa_required");

    const created = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "code", rolePreset: "treasurer" },
      mfa: true,
    });
    const { code } = created.json<{ code: string }>();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    const person = await buildPerson(s);
    const accepted = await api(person.id, "POST", "/invitations/accept", { body: { code: typed } });
    expect(accepted.statusCode).toBe(200);
    const { rows } = await t.query<{ role: string }>(
      "admin",
      "SELECT role FROM club_role_assignments WHERE club_id = $1 AND person_id = $2 AND valid_to IS NULL",
      [club.id, person.id],
    );
    expect(rows).toEqual([{ role: "treasurer" }]);
  });

  it("an email invitation is for the invited address only, and only once", async () => {
    const invited = await buildPerson(s);
    const created = await api(registrar.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "email", email: invited.email!.toUpperCase() },
    });
    expect(created.statusCode).toBe(201);
    const { invitation, url, code } = created.json<{
      invitation: { id: string; email: string };
      url: string | null;
      code: string | null;
    }>();
    expect({ url, code, email: invitation.email }).toEqual({
      url: null,
      code: null,
      email: invited.email,
    });
    // The worker derives the token from the ID for the email (ADR 0032).
    const token = emailInvitationToken(TOKEN_KEY, invitation.id);
    const { rows: events } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'invitation.created' AND payload ->> 'invitationId' = $1",
      [invitation.id],
    );
    expect(events[0]?.n).toBe(1);

    const wrong = await buildPerson(s);
    const mismatch = await api(wrong.id, "POST", "/invitations/accept", { body: { token } });
    expect(detail(mismatch)).toBe("invitation_email_mismatch");
    const ok = await api(invited.id, "POST", "/invitations/accept", { body: { token } });
    expect(ok.statusCode).toBe(200);
    const usedUp = await api(null, "GET", `/invitations/lookup?token=${token}`);
    expect(detail(usedUp)).toBe("invitation_invalid");
    expect(await auditActionsOf(t, invitation.id)).toEqual([
      "invitation.created",
      "invitation.accepted",
    ]);
  });

  it("accepting settles a pending join request in the club", async () => {
    const approvalClub = await buildClub(s);
    const person = await buildPerson(s);
    const [request] = await s.joinRequests.request(actor(person.id, approvalClub.id), {
      personIds: [person.id],
    });
    const created = await api(
      approvalClub.manager.id,
      "POST",
      `/clubs/${approvalClub.id}/invitations`,
      {
        body: { kind: "link" },
      },
    );
    const token = decodeURIComponent(created.json<{ url: string }>().url.split("/join/")[1]!);
    await api(person.id, "POST", "/invitations/accept", { body: { token } });
    const { rows } = await t.query<{ status: string }>(
      "admin",
      "SELECT status FROM join_requests WHERE id = $1",
      [request!.joinRequestId],
    );
    expect(rows).toEqual([{ status: "approved" }]);
  });
});

describe("club creation", () => {
  const body = (slug: string) => ({ name: `Created ${slug}`, slug, country: "SE" });

  it("open: the creator becomes member and manager", async () => {
    const person = await buildPerson(s);
    const slug = `open-${Date.now().toString(36)}`;
    const res = await api(person.id, "POST", "/clubs", { body: body(slug) });
    expect(res.statusCode).toBe(201);
    const result = res.json<{ outcome: string; club: { id: string; timeZone: string } }>();
    expect(result).toMatchObject({ outcome: "created", club: { timeZone: "Europe/Stockholm" } });
    const managers = await api(person.id, "GET", `/clubs/${result.club.id}/managers`);
    expect(managers.json<{ items: { person: { id: string } }[] }>().items).toEqual([
      expect.objectContaining({ person: expect.objectContaining({ id: person.id }) as unknown }),
    ]);
  });

  it("approval: a request that an operator approves (the requester becomes manager) or rejects", async () => {
    const approvalApp = await createTestApp(env({ CLUB_CREATION: "approval" }));
    try {
      const person = await buildPerson(s);
      const operator = await buildPerson(s);
      await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [
        operator.id,
      ]);
      const slug = `approval-${Date.now().toString(36)}`;
      const res = await call(approvalApp, person.id, "POST", "/clubs", { body: body(slug) });
      const result = res.json<{ outcome: string; request: { id: string; status: string } }>();
      expect(result).toMatchObject({ outcome: "requested", request: { status: "pending" } });
      const twice = await call(approvalApp, person.id, "POST", "/clubs", {
        body: body(`${slug}-2`),
      });
      expect(detail(twice)).toBe("creation_request_exists");

      const queue = await call(approvalApp, operator.id, "GET", "/ops/club-creation-requests", {
        mfa: true,
      });
      expect(queue.statusCode).toBe(200);
      expect(queue.json<{ items: { id: string; requestedBy: { id: string } }[] }>().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: result.request.id,
            requestedBy: expect.objectContaining({ id: person.id }) as unknown,
          }),
        ]),
      );
      const notOperator = await call(approvalApp, person.id, "GET", "/ops/club-creation-requests", {
        mfa: true,
      });
      expect(notOperator.statusCode).toBe(403);

      const decided = await call(
        approvalApp,
        operator.id,
        "POST",
        `/ops/club-creation-requests/${result.request.id}/decision`,
        { body: { decision: "approve" }, mfa: true },
      );
      expect(decided.statusCode).toBe(200);
      const clubId = decided.json<{ items: { clubId: string }[] }>().items[0]!.clubId;
      const { rows } = await t.query<{ role: string }>(
        "admin",
        "SELECT role FROM club_role_assignments WHERE club_id = $1 AND person_id = $2",
        [clubId, person.id],
      );
      expect(rows).toEqual([{ role: "club_manager" }]);
      const mine = await call(approvalApp, person.id, "GET", "/me/club-creation-requests");
      expect(mine.json<{ items: { status: string }[] }>().items[0]).toMatchObject({
        status: "approved",
        clubId,
      });
    } finally {
      await approvalApp.close();
    }
  });

  it("operators_only: only an operator with a second factor creates clubs", async () => {
    const closedApp = await createTestApp(env({ CLUB_CREATION: "operators_only" }));
    try {
      const person = await buildPerson(s);
      const operator = await buildPerson(s);
      await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [
        operator.id,
      ]);
      const slug = `ops-${Date.now().toString(36)}`;
      expect(
        (await call(closedApp, person.id, "POST", "/clubs", { body: body(slug) })).statusCode,
      ).toBe(403);
      expect(
        (await call(closedApp, operator.id, "POST", "/clubs", { body: body(slug) })).statusCode,
      ).toBe(403);
      const created = await call(closedApp, operator.id, "POST", "/clubs", {
        body: body(slug),
        mfa: true,
      });
      expect(created.json()).toMatchObject({ outcome: "created" });
    } finally {
      await closedApp.close();
    }
  });
});

describe("club managers", () => {
  it("appoint, the last manager stays, hand over, recovery", async () => {
    const club = await buildClub(s);
    const member = await buildPerson(s);
    const outsider = await buildPerson(s);
    await s.memberships.addMember(club.ctx, member.id);
    const manager = club.manager.id;

    const notMember = await api(manager, "POST", `/clubs/${club.id}/managers`, {
      body: { personId: outsider.id },
      mfa: true,
    });
    expect(detail(notMember)).toBe("not_a_member");
    const last = await api(manager, "DELETE", `/clubs/${club.id}/managers/${manager}`, {
      mfa: true,
    });
    expect(last.statusCode).toBe(409);
    expect(detail(last)).toBe("last_club_manager");

    // Hand-over: the successor accepts, the proposer steps down.
    const proposed = await api(manager, "POST", `/clubs/${club.id}/manager-handovers`, {
      body: { toPersonId: member.id },
      mfa: true,
    });
    expect(proposed.statusCode).toBe(201);
    const handover = proposed.json<{ id: string; to: { id: string } }>();
    expect(handover.to.id).toBe(member.id);
    const incoming = await api(member.id, "GET", "/me/manager-handovers");
    expect(incoming.json<{ incoming: { id: string }[] }>().incoming.map((h) => h.id)).toEqual([
      handover.id,
    ]);
    const stranger = await api(outsider.id, "POST", `/manager-handovers/${handover.id}/accept`);
    expect(stranger.statusCode).toBe(404);
    const accepted = await api(member.id, "POST", `/manager-handovers/${handover.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    const managers = await api(member.id, "GET", `/clubs/${club.id}/managers`);
    expect(
      managers.json<{ items: { person: { id: string } }[] }>().items.map((m) => m.person.id),
    ).toEqual([member.id]);

    // The new manager appoints the old one again. With two administrators the
    // club has left its grace period (P1.15 A3): one cannot step down alone.
    expect(
      (
        await api(member.id, "POST", `/clubs/${club.id}/managers`, {
          body: { personId: manager },
          mfa: true,
        })
      ).statusCode,
    ).toBe(201);
    const alone = await api(manager, "DELETE", `/clubs/${club.id}/managers/${manager}`, {
      mfa: true,
    });
    expect(alone.statusCode).toBe(409);
    expect(detail(alone)).toBe("administrators_minimum");

    // Recovery: the chair cannot claim while a manager exists; an operator reassigns with a reason.
    const chair = await buildPerson(s);
    await s.memberships.addMember(actor(member.id, club.id), chair.id);
    await s.roles.assignRole(actor(member.id, club.id), chair.id, "chair");
    const claim = await api(chair.id, "POST", `/clubs/${club.id}/managers/claim`, { mfa: true });
    expect(detail(claim)).toBe("club_has_manager");
    const operator = await buildPerson(s);
    await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator.id]);
    const reassigned = await api(operator.id, "POST", `/ops/clubs/${club.id}/managers`, {
      body: { personId: chair.id, reason: "Board minutes 2026-10-01, item 4" },
      mfa: true,
    });
    expect(reassigned.statusCode).toBe(201);
    const { rows } = await t.query<{ reason: string; operator_person_id: string }>(
      "admin",
      "SELECT reason, operator_person_id FROM club_manager_reassignments WHERE club_id = $1",
      [club.id],
    );
    expect(rows).toEqual([
      { reason: "Board minutes 2026-10-01, item 4", operator_person_id: operator.id },
    ]);
    // With a third administrator the old manager steps down.
    expect(
      (await api(manager, "DELETE", `/clubs/${club.id}/managers/${manager}`, { mfa: true }))
        .statusCode,
    ).toBe(200);
    const { rows: changes } = await t.query<{ change: string }>(
      "admin",
      `SELECT payload ->> 'change' AS change FROM outbox.events
       WHERE type = 'club.manager.changed' AND payload ->> 'clubId' = $1 ORDER BY created_at, id`,
      [club.id],
    );
    expect(changes.map((c) => c.change)).toEqual([
      "handed_over",
      "appointed",
      "reassigned",
      "removed",
    ]);
  });
});

describe("invitations to several groups, each with a role (P1.15 A4)", () => {
  let club: BuiltClub;
  let registrar: Awaited<ReturnType<typeof buildPerson>>;
  let owner: Awaited<ReturnType<typeof buildPerson>>;
  let roles: { id: string; scope: string; templateKey: string | null }[];
  const roleId = (scope: string, key: string) =>
    roles.find((r) => r.scope === scope && r.templateKey === key)!.id;

  beforeAll(async () => {
    club = await buildClub(s, { joinPolicy: "invite_only" });
    registrar = await buildPerson(s);
    await s.memberships.addMember(club.ctx, registrar.id);
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
    owner = await buildPerson(s);
    await s.memberships.addMember(club.ctx, owner.id);
    roles = await s.clubRoles.rolesOfClub(club.ctx);
  });

  const groupIn = async (groupId: string, personId: string) => {
    const { rows } = await t.query<{ role_id: string }>(
      "admin",
      "SELECT role_id FROM group_memberships WHERE group_id = $1 AND person_id = $2 AND valid_to IS NULL",
      [groupId, personId],
    );
    return rows.map((r) => r.role_id);
  };

  it("adds every group with its role in one acceptance; list and lookup show them", async () => {
    const a = await s.groups.createGroup(club.ctx, { name: "P2014", kind: "team" });
    const b = await s.groups.createGroup(club.ctx, { name: "Domare", kind: "other" });
    const leader = roleId("group", "head_coach");
    const created = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: a.id }, { groupId: b.id, roleId: leader }] },
    });
    expect(created.statusCode).toBe(201);
    const { url, invitation } = created.json<{
      url: string;
      invitation: { id: string; groups: { groupId: string; roleId: string }[] };
    }>();
    const participant = roleId("group", "member");
    expect(invitation.groups).toEqual([
      { groupId: a.id, roleId: participant },
      { groupId: b.id, roleId: leader },
    ]);
    const token = decodeURIComponent(url.split("/join/")[1]!);
    const lookup = await api(null, "GET", `/invitations/lookup?token=${encodeURIComponent(token)}`);
    expect(lookup.json()).toMatchObject({
      clubId: club.id,
      groups: [
        { groupId: a.id, groupName: "P2014", role: { id: participant, templateKey: "member" } },
        { groupId: b.id, groupName: "Domare", role: { id: leader, templateKey: "head_coach" } },
      ],
      clubRole: null,
    });
    const list = await api(club.manager.id, "GET", `/clubs/${club.id}/invitations`);
    expect(
      list
        .json<{ items: { id: string; groups: unknown[] }[] }>()
        .items.find((i) => i.id === invitation.id)?.groups,
    ).toHaveLength(2);

    const person = await buildPerson(s);
    expect(
      (await api(person.id, "POST", "/invitations/accept", { body: { token } })).statusCode,
    ).toBe(200);
    expect(await groupIn(a.id, person.id)).toEqual([participant]);
    expect(await groupIn(b.id, person.id)).toEqual([leader]);

    // Already in one group, the other archived since: accepted, nothing doubled.
    const again = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: a.id }, { groupId: b.id }] },
    });
    const second = decodeURIComponent(again.json<{ url: string }>().url.split("/join/")[1]!);
    await t.query("admin", "UPDATE groups SET archived_at = now() WHERE id = $1", [b.id]);
    const other = await buildPerson(s);
    await s.memberships.addMember(club.ctx, other.id);
    await s.memberships.addToGroup(club.ctx, a.id, other.id);
    expect(
      (await api(other.id, "POST", "/invitations/accept", { body: { token: second } })).statusCode,
    ).toBe(200);
    expect(await groupIn(a.id, other.id)).toHaveLength(1);
    expect(await groupIn(b.id, other.id)).toEqual([]);
  });

  it("one row per group, at most 50, groups of the club only", async () => {
    const g = await s.groups.createGroup(club.ctx, { name: "Dubbel", kind: "team" });
    const twice = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: g.id }, { groupId: g.id }] },
    });
    expect(twice.statusCode).toBe(400);
    const otherClub = await buildClub(s);
    const foreign = await s.groups.createGroup(otherClub.ctx, { name: "Främmande", kind: "team" });
    const refused = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: foreign.id }] },
    });
    expect(refused.statusCode).toBe(404);
  });

  it("a role other than the participant role needs group.members.manage (no escalation)", async () => {
    const g = await s.groups.createGroup(club.ctx, { name: "F2016", kind: "team" });
    // The registrar invites to any group, as a participant only.
    const participant = await api(registrar.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: g.id }] },
    });
    expect(participant.statusCode).toBe(201);
    const asLeader = await api(registrar.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: g.id, roleId: roleId("group", "head_coach") }] },
    });
    expect(asLeader.statusCode).toBe(403);
    expect(detail(asLeader)).toBe("group_role_not_allowed");
    // A club role is not a group role.
    const clubRole = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: g.id, roleId: roleId("club", "treasurer") }] },
    });
    expect(clubRole.statusCode).toBe(404);
  });

  it("group owners invite to their own groups, with roles within what owning gives", async () => {
    const own = await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" });
    const notOwn = await s.groups.createGroup(club.ctx, { name: "F2013", kind: "team" });
    await s.groups.addOwner(club.ctx, own.id, owner.id, "club_manager");
    const historian = await s.clubRoles.createRole(club.ctx, {
      scope: "group",
      names: { sv: "Krönikör" },
      permissions: ["group.participate", "group.owners.manage"],
    });

    const leader = await api(owner.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: own.id, roleId: roleId("group", "head_coach") }] },
    });
    expect(leader.statusCode).toBe(201);
    const ownId = leader.json<{ invitation: { id: string } }>().invitation.id;
    const escalation = await api(owner.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: own.id, roleId: historian.id }] },
    });
    expect(detail(escalation)).toBe("group_role_not_allowed");
    const elsewhere = await api(owner.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", groups: [{ groupId: own.id }, { groupId: notOwn.id }] },
    });
    expect(elsewhere.statusCode).toBe(403);
    // To the club only, or with a club role: not for owners.
    for (const body of [
      { kind: "link" },
      { kind: "link", groups: [{ groupId: own.id }], rolePreset: "treasurer" },
    ]) {
      expect(
        (await api(owner.id, "POST", `/clubs/${club.id}/invitations`, { body })).statusCode,
      ).toBe(403);
    }
    // Owners see and revoke their own invitations only.
    const byManager = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link" },
    });
    const managerId = byManager.json<{ invitation: { id: string } }>().invitation.id;
    const list = await api(owner.id, "GET", `/clubs/${club.id}/invitations`);
    expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([ownId]);
    expect(
      (await api(owner.id, "POST", `/clubs/${club.id}/invitations/${managerId}/revoke`)).statusCode,
    ).toBe(404);
    expect(
      (await api(owner.id, "POST", `/clubs/${club.id}/invitations/${ownId}/revoke`)).statusCode,
    ).toBe(200);
  });

  it("a club role by ID, given on acceptance (club manager with MFA)", async () => {
    const office = await s.clubRoles.createRole(club.ctx, {
      scope: "club",
      names: { sv: "Kansli" },
      permissions: ["club.members.read"],
    });
    const byRegistrar = await api(registrar.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", clubRoleId: office.id },
      mfa: true,
    });
    expect(detail(byRegistrar)).toBe("role_preset_not_allowed");
    const created = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", clubRoleId: office.id },
      mfa: true,
    });
    expect(created.json<{ invitation: { clubRoleId: string } }>().invitation.clubRoleId).toBe(
      office.id,
    );
    const token = decodeURIComponent(created.json<{ url: string }>().url.split("/join/")[1]!);
    const lookup = await api(null, "GET", `/invitations/lookup?token=${encodeURIComponent(token)}`);
    expect(lookup.json()).toMatchObject({ clubRole: { id: office.id, names: { sv: "Kansli" } } });
    const person = await buildPerson(s);
    await api(person.id, "POST", "/invitations/accept", { body: { token } });
    const { rows } = await t.query<{ role_id: string }>(
      "admin",
      "SELECT role_id FROM club_role_assignments WHERE club_id = $1 AND person_id = $2 AND valid_to IS NULL",
      [club.id, person.id],
    );
    expect(rows).toEqual([{ role_id: office.id }]);
    // A role preset is stored as its club role too.
    const preset = await api(club.manager.id, "POST", `/clubs/${club.id}/invitations`, {
      body: { kind: "link", rolePreset: "treasurer" },
      mfa: true,
    });
    expect(preset.json<{ invitation: { clubRoleId: string } }>().invitation.clubRoleId).toBe(
      roleId("club", "treasurer"),
    );
  });

  it("while the club needs administrators, only invitations for an administrator", async () => {
    const needy = await buildClub(s, { administratorsGrace: false });
    const plain = await api(needy.manager.id, "POST", `/clubs/${needy.id}/invitations`, {
      body: { kind: "link" },
    });
    expect(plain.statusCode).toBe(409);
    expect(detail(plain)).toBe("club_needs_administrators");
    const admin = await api(needy.manager.id, "POST", `/clubs/${needy.id}/invitations`, {
      body: { kind: "link", rolePreset: "club_manager" },
      mfa: true,
    });
    expect(admin.statusCode).toBe(201);
  });
});
