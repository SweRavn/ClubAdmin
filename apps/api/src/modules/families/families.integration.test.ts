// SPDX-License-Identifier: AGPL-3.0-only
// Families through the HTTP API (P1.3): adding children, co-guardians,
// relatives and contact persons with chosen rights, invitation links,
// duplicates and merges, own logins, the club's paper forms and the adult
// decision. Any number of guardians: one test has a child with four.

import { sql } from "@clubadmin/db";
import { countQueries, createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { guardianInvitationToken } from "@clubadmin/server-kit/invitations";
import { ON_BEHALF_OF_HEADER } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  actor,
  buildClub,
  buildFamily,
  buildPerson,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import {
  type CoreServices,
  createCoreServices,
  TEST_INVITATION_TOKEN_KEY,
} from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    ...NO_RATE_LIMITS,
  });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

type Method = "GET" | "POST" | "PATCH";

async function api(
  personId: string | null,
  method: Method,
  url: string,
  options: { body?: unknown; mfa?: boolean; onBehalfOf?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (personId) {
    headers.authorization = `Bearer ${await devToken(personId, { mfa: options.mfa ?? false })}`;
  }
  if (options.onBehalfOf) headers[ON_BEHALF_OF_HEADER] = options.onBehalfOf;
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;
const linkOf = (invitationId: string, resentAt: Date | null = null) =>
  guardianInvitationToken(TEST_INVITATION_TOKEN_KEY, invitationId, resentAt);

interface Guardians {
  guardians: {
    guardianshipId: string;
    person: { id: string; displayName: string };
    kind: string;
    rights: string[];
    phone?: string | null;
    consentNote?: string | null;
    canEnd: boolean;
    canChangeRights: boolean;
  }[];
  invitations: { invitationId: string; email?: string; kind: string }[];
}

async function addChild(parent: BuiltPerson, body: Record<string, unknown> = {}) {
  const res = await api(parent.id, "POST", "/me/wards", {
    body: { givenName: "Alva", familyName: parent.familyName, birthDate: "2016-04-02", ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ person: { id: string }; guardianshipId: string }>();
}

async function invite(
  by: BuiltPerson,
  wardId: string,
  body: { email: string; kind: string; rights?: string[] },
) {
  const res = await api(by.id, "POST", `/me/wards/${wardId}/guardian-invitations`, { body });
  expect(res.statusCode).toBe(201);
  return res.json<{ invitationId: string; expiresAt: string }>().invitationId;
}

describe("a family manages itself", () => {
  it("adds a child, invites the other parent, who accepts and sees the child; a grandparent is view-only", async () => {
    const anna = await buildPerson(s, { givenName: "Anna", familyName: "Lindqvist" });
    const mikael = await buildPerson(s, { givenName: "Mikael", familyName: "Lindqvist" });
    const gunilla = await buildPerson(s, { givenName: "Gunilla", familyName: "Berg" });

    const future = await api(anna.id, "POST", "/me/wards", {
      body: { givenName: "Later", familyName: "Lindqvist", birthDate: "2999-01-01" },
    });
    expect(detail(future)).toBe("birth_date_in_future");
    const { person: child } = await addChild(anna);

    const invitationId = await invite(anna, child.id, { email: mikael.email!, kind: "parent" });
    const token = linkOf(invitationId);
    const lookup = await api(null, "GET", `/guardian-invitations/lookup?token=${token}`);
    expect(lookup.json()).toMatchObject({
      kind: "parent",
      wardGivenName: "Alva",
      inviterName: "Anna Lindqvist",
    });
    // Someone else's login cannot use the link.
    const wrong = await api(gunilla.id, "POST", "/guardian-invitations/accept", {
      body: { token },
    });
    expect(detail(wrong)).toBe("invitation_email_mismatch");
    const accepted = await api(mikael.id, "POST", "/guardian-invitations/accept", {
      body: { token },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ kind: "parent", ward: { id: child.id } });
    expect(await auditActionsOf(t, invitationId)).toEqual([
      "guardianship.invited",
      "guardianship.invitation.accepted",
    ]);
    // Used: the link is gone, like an unknown one.
    expect((await api(null, "GET", `/guardian-invitations/lookup?token=${token}`)).statusCode).toBe(
      404,
    );

    const wards = (await api(mikael.id, "GET", "/me/wards")).json<{
      wards: { person: { id: string }; kind: string; birthDate?: string; hasLogin?: boolean }[];
    }>();
    expect(wards.wards).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({ id: child.id }) as unknown,
        kind: "parent",
        birthDate: "2016-04-02",
        hasLogin: false,
      }),
    ]);

    // Grandmother: the schedule only (the default).
    const grandmother = await invite(mikael, child.id, { email: gunilla.email!, kind: "relative" });
    await api(gunilla.id, "POST", "/guardian-invitations/accept", {
      body: { token: linkOf(grandmother) },
    });
    const hers = (await api(gunilla.id, "GET", "/me/wards")).json<{
      wards: { kind: string; rights: string[]; birthDate?: string }[];
    }>();
    expect(hers.wards).toEqual([
      {
        person: expect.anything() as unknown,
        kind: "relative",
        rights: ["view_schedule"],
        clubs: [],
      },
    ]);
    // She cannot act for Alva, nor invite or change anyone's rights.
    const onBehalf = await api(gunilla.id, "GET", "/me/clubs", { onBehalfOf: child.id });
    expect(onBehalf.statusCode).toBe(403);
    const herInvite = await api(gunilla.id, "POST", `/me/wards/${child.id}/guardian-invitations`, {
      body: { email: "cousin@example.test", kind: "relative" },
    });
    expect(herInvite.statusCode).toBe(404);

    // The grandmother sees the guardians' names, never their phone numbers or invitations.
    const seen = (
      await api(gunilla.id, "GET", `/me/wards/${child.id}/guardians`)
    ).json<Guardians>();
    expect(seen.guardians.map((g) => g.kind).sort()).toEqual(["parent", "parent", "relative"]);
    expect(seen.guardians.every((g) => g.phone === undefined)).toBe(true);
    expect(seen.invitations).toEqual([]);
    const own = seen.guardians.find((g) => g.person.id === gunilla.id)!;
    expect(own).toMatchObject({ canEnd: true, canChangeRights: false });
  });

  it("resends with a new link and revokes; the old link stops working", async () => {
    const parent = await buildPerson(s);
    const { person: child } = await addChild(parent);
    const id = await invite(parent, child.id, {
      email: "other-parent@example.test",
      kind: "parent",
    });

    const resent = await api(parent.id, "POST", `/guardian-invitations/${id}/resend`);
    expect(resent.statusCode).toBe(200);
    const { rows } = await t.query<{ resent_at: Date }>(
      "admin",
      "SELECT resent_at FROM guardian_invitations WHERE id = $1",
      [id],
    );
    const fresh = linkOf(id, rows[0]!.resent_at);
    expect(
      (await api(null, "GET", `/guardian-invitations/lookup?token=${linkOf(id)}`)).statusCode,
    ).toBe(404);
    expect((await api(null, "GET", `/guardian-invitations/lookup?token=${fresh}`)).statusCode).toBe(
      200,
    );

    const listed = (
      await api(parent.id, "GET", `/me/wards/${child.id}/guardians`)
    ).json<Guardians>();
    expect(listed.invitations).toEqual([
      expect.objectContaining({ invitationId: id, email: "other-parent@example.test" }),
    ]);

    expect((await api(parent.id, "POST", `/guardian-invitations/${id}/revoke`)).statusCode).toBe(
      200,
    );
    expect((await api(null, "GET", `/guardian-invitations/lookup?token=${fresh}`)).statusCode).toBe(
      404,
    );
    expect(await auditActionsOf(t, id)).toEqual([
      "guardianship.invited",
      "guardianship.invitation.resent",
      "guardianship.invitation.revoked",
    ]);
  });

  it("a child can have any number of guardians; nobody gets act_on_behalf without choosing it", async () => {
    const family = await buildFamily(s);
    const stepParent = await buildPerson(s);
    const sibling = await buildPerson(s);
    const grandmother = await buildPerson(s);
    for (const [person, kind, rights] of [
      [stepParent, "legal_guardian", undefined],
      [sibling, "relative", ["view_schedule", "sign_up"]],
      [grandmother, "relative", undefined],
    ] as const) {
      const id = await invite(family.guardian, family.child.id, {
        email: person.email!,
        kind,
        ...(rights ? { rights: [...rights] } : {}),
      });
      await api(person.id, "POST", "/guardian-invitations/accept", { body: { token: linkOf(id) } });
    }
    // A contact person without login: the neighbour who drives to training.
    const neighbour = await api(
      family.coGuardian.id,
      "POST",
      `/me/wards/${family.child.id}/guardians`,
      {
        body: {
          person: { givenName: "Nils", familyName: "Granne", phone: "+46 70 111 22 33" },
          kind: "contact_person",
        },
      },
    );
    expect(neighbour.statusCode).toBe(201);
    const refused = await api(
      family.guardian.id,
      "POST",
      `/me/wards/${family.child.id}/guardians`,
      {
        body: {
          person: { givenName: "Bad", familyName: "Idea" },
          kind: "contact_person",
          rights: ["act_on_behalf"],
        },
      },
    );
    expect(detail(refused)).toBe("rights_not_allowed");

    const list = (
      await api(family.guardian.id, "GET", `/me/wards/${family.child.id}/guardians`)
    ).json<Guardians>();
    expect(list.guardians).toHaveLength(6);
    const full = list.guardians.filter((g) => g.kind === "parent" || g.kind === "legal_guardian");
    expect(full).toHaveLength(3);
    const rightsOf = (id: string) => list.guardians.find((g) => g.person.id === id)?.rights;
    expect(rightsOf(sibling.id)).toEqual(["view_schedule", "sign_up"]);
    expect(rightsOf(grandmother.id)).toEqual(["view_schedule"]);
    const contact = list.guardians.find((g) => g.kind === "contact_person")!;
    expect(contact).toMatchObject({
      rights: ["view_schedule", "receive_messages"],
      phone: "+46 70 111 22 33",
      canChangeRights: true,
    });
    expect(list.guardians.filter((g) => g.rights.includes("act_on_behalf"))).toHaveLength(3);

    // The parent ticks "act on behalf" for the grandmother; she then may act for the child.
    const grandmotherLink = list.guardians.find((g) => g.person.id === grandmother.id)!;
    const changed = await api(
      family.guardian.id,
      "PATCH",
      `/guardianships/${grandmotherLink.guardianshipId}`,
      {
        body: { rights: ["view_schedule", "act_on_behalf"] },
      },
    );
    expect(changed.json()).toMatchObject({ rights: ["view_schedule", "act_on_behalf"] });
    expect(
      (await api(grandmother.id, "GET", "/me/clubs", { onBehalfOf: family.child.id })).statusCode,
    ).toBe(200);
    // ... but a relative still cannot link people or change rights, even acting for the child.
    expect(
      (
        await api(grandmother.id, "PATCH", `/guardianships/${contact.guardianshipId}`, {
          body: { rights: ["view_schedule"] },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api(grandmother.id, "POST", `/me/wards/${family.child.id}/guardians`, {
          onBehalfOf: family.child.id,
          body: { person: { givenName: "X", familyName: "Y" }, kind: "relative" },
        })
      ).statusCode,
    ).toBe(404);
    // A parent acting for the child cannot invite either.
    expect(
      (
        await api(family.guardian.id, "POST", `/me/wards/${family.child.id}/guardian-invitations`, {
          onBehalfOf: family.child.id,
          body: { email: "x@example.test", kind: "relative" },
        })
      ).statusCode,
    ).toBe(404);

    // The grandmother ends her own link; full guardians cannot end each other.
    expect(
      (await api(grandmother.id, "POST", `/guardianships/${grandmotherLink.guardianshipId}/end`))
        .statusCode,
    ).toBe(200);
    const other = full.find((g) => g.person.id !== family.guardian.id)!;
    expect(
      detail(await api(family.guardian.id, "POST", `/guardianships/${other.guardianshipId}/end`)),
    ).toBe("not_allowed");
  });
});

describe("read budget", () => {
  it("GET /me/wards answers in at most five queries, whatever the number of wards and clubs", async () => {
    const parent = await buildPerson(s);
    const clubs = [await buildClub(s), await buildClub(s)];
    for (let i = 0; i < 4; i++) {
      const { person } = await addChild(parent, { givenName: `Barn${i}` });
      await s.memberships.addMember(clubs[i % 2]!.ctx, person.id);
    }
    await api(parent.id, "GET", "/me/wards");
    const { queries, result } = await countQueries(() => api(parent.id, "GET", "/me/wards"));
    const body = result.json<{ wards: { clubs: unknown[] }[] }>();
    expect(body.wards).toHaveLength(4);
    expect(body.wards.every((w) => w.clubs.length === 1)).toBe(true);
    // The relationship set (no cache here), the wards, their clubs, their logins.
    expect(queries).toBeLessThanOrEqual(5);
  });
});

describe("trusted people of an adult", () => {
  it("an adult member links an LSS contact person to themselves, changes the rights and ends it", async () => {
    const member = await buildPerson(s, { birthDate: "1990-01-01" });
    const added = await api(member.id, "POST", "/me/trusted-people", {
      body: {
        person: { givenName: "Karin", familyName: "Stöd", phone: "+46 70 222 33 44" },
        kind: "contact_person",
      },
    });
    expect(added.statusCode).toBe(201);
    const { guardianshipId } = added.json<{ guardianship: { guardianshipId: string } }>()
      .guardianship;
    const invited = await api(member.id, "POST", "/me/trusted-people", {
      body: {
        email: "mother@example.test",
        kind: "relative",
        rights: ["view_schedule", "act_on_behalf"],
      },
    });
    expect(invited.statusCode).toBe(201);

    const mine = (await api(member.id, "GET", "/me/trusted-people")).json<{
      canLink: boolean;
      people: { guardianshipId: string; rights: string[]; canEnd: boolean }[];
      invitations: { kind: string; rights: string[] }[];
    }>();
    expect(mine.canLink).toBe(true);
    expect(mine.people).toEqual([
      expect.objectContaining({
        guardianshipId,
        rights: ["view_schedule", "receive_messages"],
        canEnd: true,
      }),
    ]);
    expect(mine.invitations).toEqual([
      expect.objectContaining({ kind: "relative", rights: ["view_schedule", "act_on_behalf"] }),
    ]);
    const patched = await api(member.id, "PATCH", `/guardianships/${guardianshipId}`, {
      body: { rights: ["receive_messages"] },
    });
    expect(patched.json()).toMatchObject({ rights: ["receive_messages"] });
    expect((await api(member.id, "POST", `/guardianships/${guardianshipId}/end`)).statusCode).toBe(
      200,
    );
    expect(
      (await api(member.id, "GET", "/me/trusted-people")).json<{ people: unknown[] }>().people,
    ).toEqual([]);
  });

  it("a young person links from the consent age only, never with act_on_behalf, and cannot remove a parent", async () => {
    const parent = await buildPerson(s);
    const year = new Date().getUTCFullYear();
    const { child: young } = await s.guardianships.addChild(actor(parent.id), {
      givenName: "Ung",
      familyName: "Person",
      birthDate: `${year - 14}-01-01`,
    });
    await s.accounts.linkAccount(actor(young.id), {
      email: "ung@example.test",
      emailVerifiedAt: new Date(),
    });
    const withAct = await api(young.id, "POST", "/me/trusted-people", {
      body: { email: "aunt@example.test", kind: "relative", rights: ["act_on_behalf"] },
    });
    expect(detail(withAct)).toBe("rights_not_allowed");
    expect(
      (
        await api(young.id, "POST", "/me/trusted-people", {
          body: { email: "aunt@example.test", kind: "relative" },
        })
      ).statusCode,
    ).toBe(201);
    const guardians = (
      await api(young.id, "GET", `/me/wards/${young.id}/guardians`)
    ).json<Guardians>();
    expect(guardians.guardians).toEqual([
      expect.objectContaining({ kind: "parent", canEnd: false }),
    ]);
    expect(
      detail(
        await api(young.id, "POST", `/guardianships/${guardians.guardians[0]!.guardianshipId}/end`),
      ),
    ).toBe("not_allowed");
  });
});

describe("the club's paper forms", () => {
  it("a registrar records a guardian and a contact person with a consent note; only a manager with MFA and a reason ends a parent", async () => {
    const club = await buildClub(s);
    const registrar = await buildPerson(s);
    await s.memberships.addMember(club.ctx, registrar.id);
    await s.roles.assignRole(club.ctx, registrar.id, "registrar");
    const family = await buildFamily(s, { club });
    const base = `/clubs/${club.id}/members/${family.child.id}/guardians`;

    const contact = await api(registrar.id, "POST", base, {
      body: {
        guardian: {
          person: { givenName: "Hämta", familyName: "Granne", phone: "+46 70 333 44 55" },
        },
        kind: "contact_person",
        consentNote: "Blankett underskriven av vårdnadshavare 2026-09-01",
      },
    });
    expect(contact.statusCode).toBe(201);
    const noNote = await api(registrar.id, "POST", base, {
      body: {
        guardian: { person: { givenName: "No", familyName: "Note" } },
        kind: "contact_person",
      },
    });
    expect(noNote.statusCode).toBe(400);
    const otherParent = await buildPerson(s);
    await s.memberships.addMember(club.ctx, otherParent.id);
    const paper = await api(registrar.id, "POST", base, {
      body: { guardian: { personId: otherParent.id }, kind: "parent" },
    });
    expect(paper.statusCode).toBe(201);
    // Not a member of the club: not found from the register.
    const outsider = await buildPerson(s);
    expect(
      (
        await api(registrar.id, "POST", base, {
          body: { guardian: { personId: outsider.id }, kind: "parent" },
        })
      ).statusCode,
    ).toBe(404);

    const listed = (await api(registrar.id, "GET", base)).json<Guardians>();
    expect(listed.guardians).toHaveLength(4);
    const recorded = listed.guardians.find((g) => g.kind === "contact_person")!;
    expect(recorded).toMatchObject({
      consentNote: "Blankett underskriven av vårdnadshavare 2026-09-01",
      phone: "+46 70 333 44 55",
      canEnd: true,
    });
    // The family sees the consent note too.
    const family1 = (
      await api(family.guardian.id, "GET", `/me/wards/${family.child.id}/guardians`)
    ).json<Guardians>();
    expect(family1.guardians.find((g) => g.kind === "contact_person")?.consentNote).toBe(
      "Blankett underskriven av vårdnadshavare 2026-09-01",
    );

    const parent = listed.guardians.find((g) => g.person.id === family.coGuardian.id)!;
    const end = (personId: string, mfa: boolean, body: Record<string, unknown> = {}) =>
      api(personId, "POST", `/clubs/${club.id}/guardianships/${parent.guardianshipId}/end`, {
        mfa,
        body,
      });
    expect(detail(await end(registrar.id, true, { reason: "x" }))).toBe("not_allowed");
    expect((await end(club.manager.id, false, { reason: "x" })).statusCode).toBe(403);
    expect(detail(await end(club.manager.id, true))).toBe("reason_required");
    expect((await end(club.manager.id, true, { reason: "Tingsrättens beslut" })).statusCode).toBe(
      200,
    );
    const { rows } = await t.query<{ ended_reason: string }>(
      "admin",
      "SELECT ended_reason FROM guardianships WHERE id = $1",
      [parent.guardianshipId],
    );
    expect(rows[0]?.ended_reason).toBe("Tingsrättens beslut");
    const { rows: events } = await t.query<{ changed_fields: string[]; payload: unknown }>(
      "admin",
      "SELECT changed_fields FROM audit.events WHERE resource_id = $1 AND action = 'guardianship.ended'",
      [parent.guardianshipId],
    );
    expect(events[0]?.changed_fields).toContain("ended_reason");
    expect(JSON.stringify(events)).not.toContain("Tingsrätt");

    // The registrar ends the contact person the club recorded.
    expect(
      (
        await api(
          registrar.id,
          "POST",
          `/clubs/${club.id}/guardianships/${recorded.guardianshipId}/end`,
          {
            body: {},
          },
        )
      ).statusCode,
    ).toBe(200);
    // Another club sees nothing.
    const other = await buildClub(s);
    expect((await api(other.manager.id, "GET", base)).statusCode).toBe(404);
  });
});

describe("duplicates", () => {
  it("both parents created the same child: one merges, the history is kept, and the merge can be undone", async () => {
    const club = await buildClub(s);
    const family = await buildFamily(s, { club, childBirthDate: "2015-06-15" });
    const child = await s.people.getPerson(actor(family.guardian.id), family.child.id);
    // The other parent added the same child again.
    const { child: duplicate } = await s.guardianships.addChild(actor(family.coGuardian.id), {
      givenName: child.givenName,
      familyName: child.familyName,
      birthDate: "2015-06-15",
    });

    type Duplicates = {
      pairs: {
        person: { person: { id: string }; clubs: { id: string }[] };
        duplicate: { person: { id: string } };
        reason: string;
        canMerge: boolean;
      }[];
      merges: { mergeId: string }[];
    };
    const forGuardian = (await api(family.guardian.id, "GET", "/me/duplicates")).json<Duplicates>();
    expect(forGuardian.pairs).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({
          person: expect.objectContaining({ id: child.id }) as unknown,
          clubs: [expect.objectContaining({ id: club.id })],
        }) as unknown,
        duplicate: expect.objectContaining({
          person: expect.objectContaining({ id: duplicate.id }) as unknown,
        }) as unknown,
        reason: "name_and_birth_date",
        // Not a guardian of the duplicate: the other parent merges.
        canMerge: false,
      }),
    ]);
    const forCo = (await api(family.coGuardian.id, "GET", "/me/duplicates")).json<Duplicates>();
    expect(forCo.pairs.map((p) => p.canMerge)).toEqual([true]);

    const merged = await api(family.coGuardian.id, "POST", `/people/${child.id}/merge`, {
      body: { duplicatePersonId: duplicate.id },
    });
    expect(merged.statusCode).toBe(201);
    const { mergeId } = merged.json<{ mergeId: string }>();
    const after = (await api(family.coGuardian.id, "GET", "/me/duplicates")).json<Duplicates>();
    expect(after.pairs).toEqual([]);
    expect(after.merges).toEqual([expect.objectContaining({ mergeId })]);
    expect(await auditActionsOf(t, child.id)).toContain("person.merged");

    expect(
      (await api(family.coGuardian.id, "POST", `/people/merges/${mergeId}/undo`)).statusCode,
    ).toBe(200);
    expect(
      (await api(family.coGuardian.id, "GET", "/me/duplicates")).json<Duplicates>().pairs,
    ).toHaveLength(1);
  });

  it("never merges away a person with a login; protected duplicates stay hidden from those who may not see them", async () => {
    const family = await buildFamily(s);
    // The other parent logs in: they cannot be merged away.
    const refused = await api(family.guardian.id, "POST", `/people/${family.child.id}/merge`, {
      body: { duplicatePersonId: family.coGuardian.id },
    });
    expect(detail(refused)).toBe("merge_not_allowed");

    const child = await s.people.getPerson(actor(family.guardian.id), family.child.id);
    const { child: hidden } = await s.guardianships.addChild(actor(family.coGuardian.id), {
      givenName: child.givenName,
      familyName: child.familyName,
      birthDate: child.birthDate!,
      protectedIdentity: true,
    });
    const pairs = (await api(family.guardian.id, "GET", "/me/duplicates")).json<{
      pairs: unknown[];
    }>();
    expect(pairs.pairs).toEqual([]);
    const co = (await api(family.coGuardian.id, "GET", "/me/duplicates")).json<{
      pairs: { duplicate: { person: { id: string; protected: boolean } } }[];
    }>();
    expect(co.pairs.map((p) => p.duplicate.person)).toEqual([
      expect.objectContaining({ id: hidden.id, protected: true }),
    ]);
  });

  it("lists duplicates among a club's members for its administrators, paged", async () => {
    const club = await buildClub(s);
    for (let i = 0; i < 3; i++) {
      const a = await buildPerson(s, { familyName: `Dubblett${i}`, birthDate: "2001-02-03" });
      const b = await buildPerson(s, { familyName: `dubblett${i}`, birthDate: "2001-02-03" });
      await s.memberships.addMember(club.ctx, a.id);
      await s.memberships.addMember(club.ctx, b.id);
    }
    const first = (await api(club.manager.id, "GET", `/clubs/${club.id}/duplicates?limit=2`)).json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await api(
        club.manager.id,
        "GET",
        `/clubs/${club.id}/duplicates?limit=2&cursor=${first.nextCursor}`,
      )
    ).json<{ items: unknown[]; nextCursor: string | null }>();
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items).toHaveLength(1);
  });
});

describe("own login and the adult age", () => {
  it("a guardian gives a 13-year-old their own login; below the age and with a login it is refused", async () => {
    const parent = await buildPerson(s);
    const year = new Date().getUTCFullYear();
    const { person: vera } = await addChild(parent, {
      givenName: "Vera",
      birthDate: `${year - 13}-01-01`,
    });
    const { person: small } = await addChild(parent, {
      givenName: "Liten",
      birthDate: `${year - 10}-01-01`,
    });
    const ok = await api(parent.id, "POST", `/people/${vera.id}/own-login-invitations`, {
      body: { email: "vera@example.test" },
    });
    expect(ok.statusCode).toBe(201);
    const young = await api(parent.id, "POST", `/people/${small.id}/own-login-invitations`, {
      body: { email: "liten@example.test" },
    });
    expect(detail(young)).toBe("too_young_for_account");
    const wards = (await api(parent.id, "GET", "/me/wards")).json<{
      wards: { person: { id: string }; ownLoginFromAge?: number }[];
    }>();
    expect(wards.wards.every((w) => w.ownLoginFromAge === 13)).toBe(true);
    await s.accounts.linkAccount(actor(vera.id), {
      email: "vera@example.test",
      emailVerifiedAt: new Date(),
    });
    const again = await api(parent.id, "POST", `/people/${vera.id}/own-login-invitations`, {
      body: { email: "vera2@example.test" },
    });
    expect(detail(again)).toBe("account_exists");
  });

  it("at the adult age the young person keeps one guardian and ends the other, once", async () => {
    const family = await buildFamily(s, { childBirthDate: "2008-01-01" });
    await s.accounts.linkAccount(actor(family.child.id), {
      email: "adult@example.test",
      emailVerifiedAt: new Date(),
    });
    await t.query(
      "admin",
      "UPDATE guardianships SET ward_adult_flagged_at = now() WHERE ward_person_id = $1",
      [family.child.id],
    );
    const list = (await api(family.child.id, "GET", "/me/adult-guardians")).json<{
      guardians: { guardianshipId: string; person: { id: string }; decision: string | null }[];
    }>();
    expect(list.guardians).toHaveLength(2);
    const [keep, end] = [
      list.guardians.find((g) => g.person.id === family.guardian.id)!,
      list.guardians.find((g) => g.person.id === family.coGuardian.id)!,
    ];
    // Only the young person decides.
    expect(
      (
        await api(
          family.guardian.id,
          "POST",
          `/me/adult-guardians/${end.guardianshipId}/decision`,
          {
            body: { decision: "end" },
          },
        )
      ).statusCode,
    ).toBe(404);
    await api(family.child.id, "POST", `/me/adult-guardians/${keep.guardianshipId}/decision`, {
      body: { decision: "keep" },
    });
    const ended = await api(
      family.child.id,
      "POST",
      `/me/adult-guardians/${end.guardianshipId}/decision`,
      {
        body: { decision: "end" },
      },
    );
    expect(ended.json()).toMatchObject({ status: "ended" });
    const twice = await api(
      family.child.id,
      "POST",
      `/me/adult-guardians/${keep.guardianshipId}/decision`,
      {
        body: { decision: "end" },
      },
    );
    expect(detail(twice)).toBe("adult_decision_not_open");
    const after = (await api(family.child.id, "GET", "/me/adult-guardians")).json<{
      guardians: { decision: string | null }[];
    }>();
    // The ended guardian is gone; the kept one stays with the decision.
    expect(after.guardians.map((g) => g.decision)).toEqual(["kept"]);
    const { rows } = await t.db.withSystem("test", {}, (tx) =>
      tx.execute<{ type: string }>(
        sql`SELECT type FROM outbox.events WHERE payload->>'guardianshipId' = ${end.guardianshipId}`,
      ),
    );
    expect(rows.map((r) => r.type)).toContain("guardianship.adult.ended");
  });
});
