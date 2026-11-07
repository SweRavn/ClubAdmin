// SPDX-License-Identifier: AGPL-3.0-only
// Protected identity through the HTTP API (P1.12, ADR 0022): turning the
// global and club flags on and off (step-ups, the removal rule, the address),
// the protection state on the profile, the profile view log (always for
// protected people, every view in a club that logs all), the person's access
// log and the club's log, adding a protected child and the register filter.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClub,
  buildFamily,
  buildPerson,
  type BuiltClub,
  type BuiltFamily,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;
let club: BuiltClub;
let family: BuiltFamily;
let coach: BuiltPerson;
let registrar: BuiltPerson;
let adult: BuiltPerson;

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
  club = await buildClub(s);
  family = await buildFamily(s, { club });
  coach = await buildPerson(s);
  registrar = await buildPerson(s);
  adult = await buildPerson(s);
  for (const p of [coach, registrar, adult]) await s.memberships.addMember(club.ctx, p.id);
  await s.roles.assignRole(club.ctx, registrar.id, "registrar");
  const team = await s.groups.createGroup(club.ctx, { name: "P2016", kind: "team" });
  await s.memberships.addToGroup(club.ctx, team.id, family.child.id, "member");
  await s.memberships.addToGroup(club.ctx, team.id, coach.id, "head_coach");
}, 120_000);
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

async function call(
  personId: string,
  method: "GET" | "PUT" | "POST",
  url: string,
  options: { body?: unknown; mfa?: boolean; authAgeSeconds?: number } = {},
) {
  const token = await devToken(personId, {
    ...(options.mfa ? { mfa: true } : {}),
    ...(options.authAgeSeconds ? { authAgeSeconds: options.authAgeSeconds } : {}),
  });
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}

const detail = (res: { json: () => unknown }) => (res.json() as { detail?: string }).detail;
const OLD_LOGIN = 60 * 60;

describe("the global flag", () => {
  it("lets an adult protect themselves (the address goes) and needs a recent login to stop", async () => {
    await t.query(
      "admin",
      `UPDATE people SET address = '{"street":"Gatan 1","postalCode":"11122","city":"Stad","country":"SE"}'
       WHERE id = $1`,
      [adult.id],
    );
    const on = await call(adult.id, "PUT", `/people/${adult.id}/protection`, {
      body: { protected: true },
    });
    expect(on.statusCode).toBe(200);
    const { rows } = await t.query<{ protected_identity: boolean; address: unknown; by: string }>(
      "admin",
      "SELECT protected_identity, address, protected_identity_set_by_person_id AS by FROM people WHERE id = $1",
      [adult.id],
    );
    expect(rows[0]).toEqual({ protected_identity: true, address: null, by: adult.id });
    const profile = await call(adult.id, "GET", `/people/${adult.id}`);
    expect(profile.json()).toMatchObject({
      protection: { global: true, canChangeGlobal: true, canRemoveGlobal: true },
    });

    const stale = await call(adult.id, "PUT", `/people/${adult.id}/protection`, {
      body: { protected: false },
      authAgeSeconds: OLD_LOGIN,
    });
    expect(stale.statusCode).toBe(403);
    expect(detail(stale)).toBe("recent_auth_required");
    const off = await call(adult.id, "PUT", `/people/${adult.id}/protection`, {
      body: { protected: false },
    });
    expect(off.statusCode).toBe(200);
    expect(await auditActionsOf(t, adult.id)).toContain("person.protection.changed");
  });

  it("lets a guardian protect a child; the other guardian cannot remove it; the setter can", async () => {
    const child = family.child.id;
    expect(
      (
        await call(family.guardian.id, "PUT", `/people/${child}/protection`, {
          body: { protected: true },
        })
      ).statusCode,
    ).toBe(200);
    const refused = await call(family.coGuardian.id, "PUT", `/people/${child}/protection`, {
      body: { protected: false },
    });
    expect(refused.statusCode).toBe(403);
    expect(detail(refused)).toBe("protection_removal_not_allowed");
    expect(await auditActionsOf(t, child)).toContain("person.protection.removal_refused");
    const state = await call(family.coGuardian.id, "GET", `/people/${child}`);
    expect(state.json()).toMatchObject({
      protection: { global: true, canChangeGlobal: true, canRemoveGlobal: false },
    });
    // Leaders see the person (with the icon), never the protection state.
    const asCoach = await call(coach.id, "GET", `/people/${child}?clubId=${club.id}`);
    expect(asCoach.statusCode).toBe(200);
    expect(asCoach.json()).not.toHaveProperty("protection");
    expect(asCoach.json()).toMatchObject({ viewsLogged: true, person: { protected: true } });
    // Others in the club are not even allowed to try.
    expect(
      (
        await call(registrar.id, "PUT", `/people/${child}/protection`, {
          body: { protected: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("the club flag", () => {
  it("is set by a club manager with a second factor and stops sharing the address", async () => {
    await t.query(
      "admin",
      "UPDATE club_profiles SET shared_fields = '{phone,address}' WHERE club_id = $1 AND person_id = $2",
      [club.id, coach.id],
    );
    const url = `/people/${coach.id}/protection?clubId=${club.id}`;
    const noMfa = await call(club.manager.id, "PUT", url, { body: { protected: true } });
    expect(noMfa.statusCode).toBe(403);
    expect([403, 404]).toContain(
      (await call(registrar.id, "PUT", url, { body: { protected: true }, mfa: true })).statusCode,
    );
    expect(
      (await call(club.manager.id, "PUT", url, { body: { protected: true }, mfa: true }))
        .statusCode,
    ).toBe(200);
    const { rows } = await t.query<{ shared_fields: string[]; by: string }>(
      "admin",
      `SELECT shared_fields, protected_identity_club_set_by_person_id AS by FROM club_profiles
       WHERE club_id = $1 AND person_id = $2`,
      [club.id, coach.id],
    );
    expect(rows[0]).toEqual({ shared_fields: ["phone"], by: club.manager.id });
    const panel = await call(club.manager.id, "GET", `/people/${coach.id}?clubId=${club.id}`, {
      mfa: true,
    });
    expect(panel.json()).toMatchObject({
      protection: { club: true, canChangeClub: true, clubSetBy: { id: club.manager.id } },
    });
    const register = await call(
      club.manager.id,
      "GET",
      `/clubs/${club.id}/members?protected=only`,
      { mfa: true },
    );
    const items = register.json<{ items: { person: { id: string }; protection: unknown }[] }>()
      .items;
    expect(items.find((i) => i.person.id === coach.id)?.protection).toMatchObject({
      source: "club",
    });
    expect(items.every((i) => i.protection !== undefined)).toBe(true);
  });
});

describe("the profile view log", () => {
  it("shows the family who opened a protected child's profile, and the club's managers the club log", async () => {
    const child = family.child.id;
    const log = await call(family.guardian.id, "GET", `/people/${child}/access-log`);
    expect(log.statusCode).toBe(200);
    const items = log.json<{
      items: {
        viewer: { kind: string; person?: { id: string } };
        club: { id: string } | null;
        viewerRole: string | null;
      }[];
    }>().items;
    // The coach opened it in the club; protected in the club since the
    // previous test, so the family sees "someone with protected identity".
    const inClub = items.find((i) => i.club?.id === club.id);
    expect(inClub).toMatchObject({ viewer: { kind: "protected" }, viewerRole: "group_leader" });
    // Nobody else reads it.
    expect((await call(coach.id, "GET", `/people/${child}/access-log`)).statusCode).toBe(404);
    expect(
      (await call(club.manager.id, "GET", `/people/${child}/access-log`, { mfa: true })).statusCode,
    ).toBe(404);

    const clubLog = await call(club.manager.id, "GET", `/clubs/${club.id}/profile-views`, {
      mfa: true,
    });
    expect(clubLog.statusCode).toBe(200);
    expect(clubLog.json()).toMatchObject({ mode: "protected_only" });
    expect((await call(registrar.id, "GET", `/clubs/${club.id}/profile-views`)).statusCode).toBe(
      403,
    );
  });

  it("logs every view once the club chooses so; the member sees it", async () => {
    const url = `/clubs/${club.id}/profile-view-logging`;
    expect(
      (await call(registrar.id, "PUT", url, { body: { mode: "all" }, mfa: true })).statusCode,
    ).toBe(403);
    expect(
      (await call(club.manager.id, "PUT", url, { body: { mode: "all" }, mfa: true })).statusCode,
    ).toBe(200);
    const view = await call(registrar.id, "GET", `/people/${adult.id}?clubId=${club.id}`);
    expect(view.json()).toMatchObject({ viewsLogged: true });
    const own = await call(adult.id, "GET", `/people/${adult.id}/access-log`);
    const viewers = own
      .json<{ items: { viewer: { person?: { id: string } }; protected: boolean }[] }>()
      .items.map((i) => i.viewer.person?.id);
    expect(viewers).toContain(registrar.id);
    expect(await auditActionsOf(t, club.id)).toContain("club.settings.updated");
  });
});

describe("adding a protected child", () => {
  it("creates the child protected, set by the guardian, and lists the flag", async () => {
    const parent = await buildPerson(s);
    const res = await call(parent.id, "POST", "/me/wards", {
      body: {
        givenName: "Ada",
        familyName: "Skyddad",
        birthDate: "2018-05-05",
        protectedIdentity: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const childId = res.json<{ person: { id: string; protected: boolean } }>().person.id;
    const wards = await call(parent.id, "GET", "/me/wards");
    const ward = wards
      .json<{ wards: { person: { id: string }; protectedIdentity?: boolean }[] }>()
      .wards.find((w) => w.person.id === childId);
    expect(ward?.protectedIdentity).toBe(true);
  });
});
