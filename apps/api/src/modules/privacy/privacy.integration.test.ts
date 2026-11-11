// SPDX-License-Identifier: AGPL-3.0-only
// Consents, board decisions and the privacy policy, leaving a club and
// stepping down (P1.8a), through the services against the database.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import type { OutstandingObligationsProvider } from "./outstanding-obligations.ts";

let t: TestDatabase;
let s: CoreServices;
/** People with an open invoice (the fake finance provider). */
const owing = new Set<string>();
const obligations: OutstandingObligationsProvider[] = [
  {
    forPerson: (_tx, _clubId, personId) =>
      Promise.resolve(owing.has(personId) ? { count: 1, contactRole: "treasurer" } : null),
  },
];

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db, { obligations });
});
afterAll(async () => {
  await t?.drop();
});

const isError = (code: string) => (e: unknown) => isDomainError(e, code as never);

describe("consents", () => {
  it("a parent gives and withdraws a 10-year-old's photo consent; the child cannot", async () => {
    const club = await buildClub(s);
    const family = await buildFamily(s, { club, childBirthDate: "2016-03-01" });
    const ctx = actor(family.guardian.id, club.id);
    await s.consents.give(ctx, "guardian", family.child.id, "photo_publication", {
      textVersion: "default:1",
    });
    const status = await s.consents.personConsents(ctx, family.child.id, "guardian");
    const photo = status.statuses.find((p) => p.purpose === "photo_publication")!;
    expect(photo.open?.source).toBe("guardian");
    expect(photo.current).toBe(true);
    expect(photo.mayWithdraw).toBe(true);

    // The child (no login in practice) is below the consent age.
    await expect(
      s.consents.withdraw(
        actor(family.child.id, club.id),
        "self",
        family.child.id,
        "photo_publication",
      ),
    ).rejects.toSatisfy(isError("consent_age_required"));

    await s.consents.withdraw(ctx, "guardian", family.child.id, "photo_publication");
    const after = await s.consents.personConsents(ctx, family.child.id, "guardian");
    expect(after.history[0]).toMatchObject({ revokedReason: "withdrawn" });
    expect(await auditActionsOf(t, after.history[0]!.id)).toEqual([
      "consent.given",
      "consent.withdrawn",
    ]);
  });

  it("refuses an outdated text, a purpose not asked for and a protected person's photos", async () => {
    const club = await buildClub(s);
    const p = await buildPerson(s);
    await s.memberships.addMember(club.ctx, p.id);
    const ctx = actor(p.id, club.id);
    await expect(
      s.consents.give(ctx, "self", p.id, "photo_publication", { textVersion: "default:2" }),
    ).rejects.toSatisfy(isError("consent_text_outdated"));
    await expect(
      s.consents.give(ctx, "self", p.id, "marketing", { textVersion: "default:1" }),
    ).rejects.toSatisfy(isError("consent_purpose_not_asked"));
    await s.people.setProtectedIdentity(actor(p.id), p.id, true);
    await expect(
      s.consents.give(ctx, "self", p.id, "photo_publication", { textVersion: "default:1" }),
    ).rejects.toSatisfy(isError("consent_not_applicable"));
  });

  it("a registrar records a paper consent with a note; a new club text supersedes with reconfirm on", async () => {
    const club = await buildClub(s);
    const p = await buildPerson(s);
    await s.memberships.addMember(club.ctx, p.id);
    await s.consents.give(club.ctx, "admin", p.id, "photo_publication", {
      textVersion: "default:1",
      clubNote: "Pappersblankett augusti",
    });
    const recorded = await s.consents.personConsents(club.ctx, p.id, "admin");
    expect(recorded.history[0]).toMatchObject({
      source: "club_record",
      clubNote: "Pappersblankett augusti",
    });

    // The board decides to reconfirm on a new version; the club publishes its own text.
    await s.clubPrivacy.recordDecision(club.ctx, {
      body: "board",
      decidedOn: new Date().toISOString().slice(0, 10),
      reference: "§ 7",
      settings: { consent_reconfirm_on_new_version: true },
    });
    await s.consents.publishText(club.ctx, {
      purpose: "photo_publication",
      texts: { sv: "Klubben får publicera bilder på dig i sina kanaler." },
    });
    const after = await s.consents.personConsents(club.ctx, p.id, "admin");
    expect(after.statuses.find((x) => x.purpose === "photo_publication")!.open).toBeNull();
    expect(after.history[0]).toMatchObject({ revokedReason: "superseded" });
  });

  it("the overview lists my clubs and my children's, and my own contact purposes in theirs", async () => {
    const club = await buildClub(s);
    await s.clubPrivacy.recordDecision(club.ctx, {
      body: "board",
      decidedOn: new Date().toISOString().slice(0, 10),
      reference: "§ 3",
      settings: { consent_purposes: ["photo_publication", "contacts_group"] },
    });
    const family = await buildFamily(s, { club });
    const overview = await s.consents.overview(actor(family.guardian.id), [family.child.id]);
    const entry = overview.clubs.find((c) => c.clubId === club.id)!;
    expect(entry.people.map((p) => [p.personId, p.purposes.map((x) => x.purpose)])).toEqual([
      [family.guardian.id, ["contacts_group"]],
      [family.child.id, ["photo_publication", "contacts_group"]],
    ]);
    // The guardian shows their own phone to the team (no membership needed).
    await s.consents.give(
      actor(family.guardian.id, club.id),
      "self",
      family.guardian.id,
      "contacts_group",
      { textVersion: "default:1" },
    );
  });
});

describe("board decisions and the privacy policy", () => {
  it("board settings change only through a decision, within the registry's and the pack's limits", async () => {
    const club = await buildClub(s);
    await expect(
      s.clubs.updateSettings(club.ctx, { formerMemberRetentionMonths: 12 }),
    ).rejects.toSatisfy(isError("decision_required"));
    const today = new Date().toISOString().slice(0, 10);
    await expect(
      s.clubPrivacy.recordDecision(club.ctx, {
        body: "board",
        decidedOn: today,
        reference: "§ 7",
        settings: { former_member_retention_months: 3 },
      }),
    ).rejects.toSatisfy(isError("decision_invalid"));
    await expect(
      s.clubPrivacy.recordDecision(club.ctx, {
        body: "board",
        decidedOn: today,
        reference: "§ 7",
        settings: { attendance_lock_days: 10 },
      }),
    ).rejects.toSatisfy(isError("decision_invalid"));

    const decision = await s.clubPrivacy.recordDecision(club.ctx, {
      body: "board",
      decidedOn: today,
      reference: "§ 7",
      settings: { former_member_retention_months: 12 },
    });
    expect(decision.appliedAt).not.toBeNull();
    expect((await s.clubs.getClub(club.ctx)).formerMemberRetentionMonths).toBe(12);
    const { versions } = await s.clubPrivacy.policies(club.ctx);
    expect(versions.map((v) => [v.version, v.decisionId])).toEqual([
      [2, decision.id],
      [1, null],
    ]);
    expect(versions[0]!.settings).toMatchObject({ former_member_retention_months: 12 });
    expect(versions[1]!.settings).toMatchObject({ former_member_retention_months: 24 });
  });

  it("a decision effective later waits", async () => {
    const club = await buildClub(s);
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const decision = await s.clubPrivacy.recordDecision(club.ctx, {
      body: "annual_meeting",
      decidedOn: today,
      reference: "§ 12",
      effectiveFrom: later,
      settings: { attendance_retention_months: 36 },
    });
    expect(decision.appliedAt).toBeNull();
    expect((await s.clubs.getClub(club.ctx)).attendanceRetentionMonths).toBe(12);
    expect((await s.clubPrivacy.overview(club.ctx)).pending.map((d) => d.id)).toEqual([
      decision.id,
    ]);
  });
});

describe("leaving a club", () => {
  it("is refused with assignments until the person steps down, then ends everything", async () => {
    const club = await buildClub(s);
    const coach = await buildPerson(s);
    await s.memberships.addMember(club.ctx, coach.id);
    const group = await s.groups.createGroup(club.ctx, { name: "F2017", kind: "team" });
    const fn = await s.memberships.addToGroup(club.ctx, group.id, coach.id, "head_coach");
    const ctx = actor(coach.id, club.id);

    const preview = await s.leaving.preview(ctx, coach.id);
    expect(preview.blockers).toMatchObject([
      { code: "roles_must_be_removed", assignments: [{ id: fn.id, kind: "group_function" }] },
    ]);
    await expect(s.leaving.leave(ctx, coach.id, { removeNow: false })).rejects.toSatisfy(
      isError("roles_must_be_removed"),
    );

    await s.leaving.stepDown(ctx, coach.id, fn.id);
    await s.consents.give(ctx, "self", coach.id, "photo_publication", { textVersion: "default:1" });
    await s.leaving.leave(ctx, coach.id, { removeNow: true });
    const { rows } = await t.query<{ status: string; consents: number; job: number }>(
      "admin",
      `SELECT (SELECT status FROM club_memberships WHERE club_id = $1 AND person_id = $2) AS status,
              (SELECT count(*)::int FROM consents WHERE club_id = $1 AND person_id = $2
                 AND revoked_reason = 'left_club') AS consents,
              (SELECT count(*)::int FROM graphile_worker.jobs
                 WHERE key = 'privacy:purge_member:' || $1 || ':' || $2) AS job`,
      [club.id, coach.id],
    );
    expect(rows[0]).toEqual({ status: "left", consents: 1, job: 1 });
  });

  it("the last club manager cannot step down; outstanding invoices refuse leaving", async () => {
    const club = await buildClub(s, { registrar: false });
    const assignments = await s.leaving.assignments(club.ctx, club.manager.id);
    expect(assignments).toMatchObject([
      { kind: "role", role: "club_manager", blockedBy: "last_club_manager" },
    ]);
    await expect(
      s.leaving.stepDown(club.ctx, club.manager.id, assignments[0]!.id),
    ).rejects.toSatisfy(isError("last_club_manager"));

    const member = await buildPerson(s);
    await s.memberships.addMember(club.ctx, member.id);
    owing.add(member.id);
    const ctx = actor(member.id, club.id);
    expect((await s.leaving.preview(ctx, member.id)).blockers).toEqual([
      { code: "outstanding_invoices", count: 1, contactRole: "treasurer" },
    ]);
    await expect(s.leaving.leave(ctx, member.id, { removeNow: false })).rejects.toSatisfy(
      isError("outstanding_invoices"),
    );
    owing.delete(member.id);
    await s.leaving.leave(ctx, member.id, { removeNow: false });
  });
});
