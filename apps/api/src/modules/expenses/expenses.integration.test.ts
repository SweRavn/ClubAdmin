// SPDX-License-Identifier: AGPL-3.0-only
// Expense claims (P2.5 part B) through the API: the mileage rate as a board
// decision (no new privacy policy version), claimable drives, a claim of
// one's drives routed to the activity's creator, attesting (never one's
// own; a rejection needs a reason), Mina utlägg, the CSV export for the
// club's attesters and erasure of the reason.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { ClaimableDrives, ExpenseClaim, ExpenseClaimPage } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { subscribeToFeatures } from "../../testing/billing.ts";
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

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function api(
  personId: string,
  method: Method,
  url: string,
  body?: unknown,
  options: { mfa?: boolean } = {},
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await devToken(personId, { mfa: options.mfa ?? false })}`,
      },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let teamId: string;
let coach: BuiltPerson;
let player: BuiltPerson;
let treasurer: BuiltPerson;
let a: BuiltFamily;
let activityId: string;
let parentOffers: string[];
let coachOffer: string;
let parentClaim: string;
let coachClaim: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
  await subscribeToFeatures(t, [club.id], ["finance"]);
  teamId = (await s.groups.createGroup(club.ctx, { name: "P2012", kind: "team" })).id;
  coach = await buildPerson(s);
  player = await buildPerson(s, { birthDate: "1990-01-01" });
  treasurer = await buildPerson(s);
  for (const p of [coach, player, treasurer]) await s.memberships.addMember(club.ctx, p.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, teamId, player.id);
  await s.roles.assignRole(club.ctx, treasurer.id, "treasurer");
  a = await buildFamily(s, { club, childBirthDate: "2014-03-01" });
  await s.memberships.addToGroup(club.ctx, teamId, a.child.id);
  const place = await api(coach.id, "POST", `/clubs/${club.id}/locations`, {
    name: "Bortaplan",
    distanceKm: 42.5,
  });
  const created = await api(coach.id, "POST", `/groups/${teamId}/activities`, {
    kind: "match",
    title: "Bortamatch",
    startsAt: `${day(2)}T10:00:00Z`,
    endsAt: `${day(2)}T12:00:00Z`,
    locationId: place.json<{ id: string }>().id,
    transportMode: "own",
  });
  activityId = created.json<{ id: string }>().id;
  const offer = await api(a.guardian.id, "POST", `/activities/${activityId}/carpool/offers`, {
    seats: 3,
    withReturn: true,
  });
  const ids = offer.json<{ id: string; returnId: string }>();
  parentOffers = [ids.id, ids.returnId];
  coachOffer = (
    await api(coach.id, "POST", `/activities/${activityId}/carpool/offers`, { seats: 2 })
  ).json<{ id: string }>().id;
  // The match has been played.
  await t.query(
    "admin",
    "UPDATE public.activities SET starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '2 hours' WHERE id = $1",
    [activityId],
  );
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("mileage claims (P2.5 part B)", () => {
  it("without a rate decided by the board, reimbursement is off", async () => {
    const res = await api(a.guardian.id, "POST", "/me/expense-claims", {
      clubId: club.id,
      groupId: teamId,
      offerIds: parentOffers,
    });
    expect([res.statusCode, detail(res)]).toEqual([409, "mileage_off"]);
  });

  it("the board decides the rate; no new privacy policy version for it", async () => {
    const before = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM public.club_privacy_policies WHERE club_id = $1",
      [club.id],
    );
    const res = await api(
      club.manager.id,
      "POST",
      `/clubs/${club.id}/setting-decisions`,
      {
        body: "board",
        decidedOn: day(0),
        reference: "Styrelsemöte 3 § 7",
        settings: { mileage_rate: 250 },
      },
      { mfa: true },
    );
    expect(res.statusCode, res.body).toBe(201);
    const { rows } = await t.query<{ mileage_rate: number }>(
      "admin",
      "SELECT mileage_rate FROM public.clubs WHERE id = $1",
      [club.id],
    );
    expect(rows[0]?.mileage_rate).toBe(250);
    const after = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM public.club_privacy_policies WHERE club_id = $1",
      [club.id],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    // A manager cannot set it through the settings (a board setting).
    const patch = await api(club.manager.id, "PATCH", `/clubs/${club.id}/settings`, {
      mileageRate: 300,
    });
    expect(patch.statusCode).toBe(403);
  });

  it("lists the driver's drives not yet claimed, with the rate", async () => {
    const res = await api(a.guardian.id, "GET", `/me/expense-claims/claimable?clubId=${club.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ClaimableDrives>();
    expect(body.mileageRate).toBe(250);
    expect(body.drives.map((d) => d.offerId).sort()).toEqual([...parentOffers].sort());
    expect(body.drives.every((d) => d.distanceKm === 42.5)).toBe(true);
  });

  it("a claim of one's drives, routed to the activity's creator who may attest", async () => {
    const res = await api(a.guardian.id, "POST", "/me/expense-claims", {
      clubId: club.id,
      groupId: teamId,
      offerIds: parentOffers,
    });
    expect(res.statusCode, res.body).toBe(201);
    parentClaim = res.json<{ id: string }>().id;
    const { rows } = await t.query<{ amount_minor: string; routed_to_person_id: string }>(
      "admin",
      "SELECT amount_minor, routed_to_person_id FROM public.expense_claims WHERE id = $1",
      [parentClaim],
    );
    expect(rows[0]).toEqual({ amount_minor: "21250", routed_to_person_id: coach.id });
    const { rows: events } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'expense_claim.submitted' AND payload->>'claimId' = $1",
      [parentClaim],
    );
    expect(events[0]?.n).toBe(1);
    const again = await api(a.guardian.id, "POST", "/me/expense-claims", {
      clubId: club.id,
      groupId: teamId,
      offerIds: [parentOffers[0]],
    });
    expect([again.statusCode, detail(again)]).toEqual([409, "claim_drive_claimed"]);
    const notMine = await api(player.id, "POST", "/me/expense-claims", {
      clubId: club.id,
      groupId: teamId,
      offerIds: [coachOffer],
    });
    expect([notMine.statusCode, detail(notMine)]).toEqual([400, "claim_drive_invalid"]);
  });

  it("the queue: the group's attester and the club's; others are refused", async () => {
    const asCoach = await api(coach.id, "GET", `/clubs/${club.id}/expense-claims`);
    expect(asCoach.statusCode, asCoach.body).toBe(200);
    const item = asCoach.json<ExpenseClaimPage>().items.find((c) => c.id === parentClaim)!;
    expect(item).toMatchObject({
      amountMinor: 21250,
      currency: "SEK",
      status: "submitted",
      canDecide: true,
      groupName: "P2012",
    });
    expect(item.claimant?.id).toBe(a.guardian.id);
    expect(item.routedTo?.id).toBe(coach.id);
    expect(item.lines).toHaveLength(2);
    const asTreasurer = await api(treasurer.id, "GET", `/clubs/${club.id}/expense-claims`);
    expect(asTreasurer.json<ExpenseClaimPage>().items.map((c) => c.id)).toContain(parentClaim);
    expect((await api(player.id, "GET", `/clubs/${club.id}/expense-claims`)).statusCode).toBe(403);
  });

  it("never one's own claim; a rejection needs a reason; decided once", async () => {
    const own = await api(coach.id, "POST", "/me/expense-claims", {
      clubId: club.id,
      groupId: teamId,
      offerIds: [coachOffer],
    });
    expect(own.statusCode, own.body).toBe(201);
    coachClaim = own.json<{ id: string }>().id;
    const self = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/expense-claims/${coachClaim}/decision`,
      {
        decision: "approve",
      },
    );
    expect([self.statusCode, detail(self)]).toEqual([403, "claim_own"]);
    const noReason = await api(
      treasurer.id,
      "POST",
      `/clubs/${club.id}/expense-claims/${coachClaim}/decision`,
      { decision: "reject" },
    );
    expect(noReason.statusCode).toBe(400);
    const rejected = await api(
      treasurer.id,
      "POST",
      `/clubs/${club.id}/expense-claims/${coachClaim}/decision`,
      { decision: "reject", reason: "Körningen gällde en annan grupp" },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<ExpenseClaim>()).toMatchObject({ status: "rejected" });

    const approved = await api(
      coach.id,
      "POST",
      `/clubs/${club.id}/expense-claims/${parentClaim}/decision`,
      { decision: "approve" },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<ExpenseClaim>().decidedBy?.id).toBe(coach.id);
    const twice = await api(
      treasurer.id,
      "POST",
      `/clubs/${club.id}/expense-claims/${parentClaim}/decision`,
      { decision: "reject", reason: "Nej" },
    );
    expect([twice.statusCode, detail(twice)]).toEqual([409, "claim_decided"]);
    expect(await auditActionsOf(t, parentClaim)).toEqual([
      "expense.claim.submitted",
      "expense.claim.approved",
    ]);
    // A rejected claim's drive may be claimed again.
    const retry = await api(coach.id, "GET", `/me/expense-claims/claimable?clubId=${club.id}`);
    expect(retry.json<ClaimableDrives>().drives.map((d) => d.offerId)).toEqual([coachOffer]);
  });

  it("Mina utlägg shows the claimant's claims and decisions", async () => {
    const res = await api(a.guardian.id, "GET", "/me/expense-claims");
    expect(res.statusCode, res.body).toBe(200);
    const mine = res.json<ExpenseClaimPage>().items;
    expect(mine.map((c) => [c.id, c.status])).toEqual([[parentClaim, "approved"]]);
    expect(mine[0]!.decidedBy?.id).toBe(coach.id);
    expect(mine[0]!.claimant?.id).toBe(a.guardian.id);
  });

  it("exports approved claims to CSV for the club's attesters, marked exported", async () => {
    const url = `/clubs/${club.id}/expense-claims/export?from=${day(-1)}&to=${day(1)}`;
    expect((await api(coach.id, "GET", url)).statusCode).toBe(403);
    const res = await api(treasurer.id, "GET", url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe("claim,decided,claimant,group,kind,km,currency,amount");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(parentClaim);
    expect(lines[1]).toContain("212.50");
    expect(lines[1]).toContain(a.guardian.givenName);
    const exported = await api(
      treasurer.id,
      "GET",
      `/clubs/${club.id}/expense-claims?status=exported`,
    );
    expect(exported.json<ExpenseClaimPage>().items.map((c) => c.id)).toEqual([parentClaim]);
  });

  it("erasure clears the attester's reason on the person's claims", async () => {
    await t.query("admin", "SELECT privacy.erase_person($1, 'test')", [coach.id]);
    const { rows } = await t.query<{ reason: string | null; status: string }>(
      "admin",
      "SELECT reason, status FROM public.expense_claims WHERE id = $1",
      [coachClaim],
    );
    expect(rows[0]).toEqual({ reason: null, status: "rejected" });
  });
});
