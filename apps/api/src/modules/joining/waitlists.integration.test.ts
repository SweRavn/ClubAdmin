// SPDX-License-Identifier: AGPL-3.0-only
// Waiting lists (P1.10b, ADR 0043) through the services: applying (members
// and people outside the club), the owners' decisions in fair order,
// answering offers, admission across the club membership and join requests,
// and the club managers' view.

import { sql } from "@clubadmin/db";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildFamily, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf, useCoreDatabase } from "../../testing/core.ts";
import type { Applicant } from "./waitlists.service.ts";

const c = useCoreDatabase();

type Club = Awaited<ReturnType<typeof buildClub>>;

const self = (personId: string, wards: string[] = []): Applicant => ({
  personIds: [personId, ...wards],
  actsFor: (id) => id === personId || wards.includes(id),
});

async function team(club: Club, fields: Record<string, unknown> = {}) {
  return c.s.groups.createGroup(club.ctx, {
    name: `F2016-${Math.random().toString(36).slice(2, 6)}`,
    kind: "team",
    admissionMode: "waitlist",
    ...fields,
  });
}

async function member(club: Club) {
  const person = await buildPerson(c.s);
  await c.s.memberships.addMember(club.ctx, person.id);
  return person;
}

async function apply(club: Club, groupId: string, personId: string, note?: string) {
  const { entry } = await c.s.waitlists.apply(actor(personId, club.id), groupId, {
    personId,
    ...(note ? { note } : {}),
  });
  return entry;
}

async function entryRow(id: string) {
  const { rows } = await c.t.query<{
    status: string;
    closed_reason: string | null;
    out_of_order_reason: string | null;
    offer_expires_at: Date | null;
    queued_at: Date;
  }>(
    "admin",
    "SELECT status, closed_reason, out_of_order_reason, offer_expires_at, queued_at FROM group_waitlist_entries WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function inGroup(groupId: string, personId: string): Promise<boolean> {
  const { rows } = await c.t.query(
    "admin",
    "SELECT 1 FROM group_memberships WHERE group_id = $1 AND person_id = $2 AND valid_to IS NULL AND function = 'member'",
    [groupId, personId],
  );
  return rows.length > 0;
}

const fails = (code: Parameters<typeof isDomainError>[1]) => (e: unknown) => isDomainError(e, code);

describe("applying", () => {
  it("puts a member on the list, shows the position and refuses twice", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    const [a, b] = [await member(club), await member(club)];
    await apply(club, group.id, a.id, "Plays goal");
    const entry = await apply(club, group.id, b.id);
    expect(await auditActionsOf(c.t, entry.id)).toContain("group.waitlist.created");
    await expect(apply(club, group.id, b.id)).rejects.toSatisfy(fails("already_on_waitlist"));

    const mine = await c.s.groups.myWaitlistEntries(actor(b.id), [b.id]);
    expect(mine).toEqual([
      expect.objectContaining({ id: entry.id, position: 2, waiting: 2, groupName: group.name }),
    ]);
  });

  it("refuses closed groups; members apply to direct groups, with or without free places", async () => {
    const club = await buildClub(c.s);
    const person = await member(club);
    const closed = await team(club, { admissionMode: "closed" });
    await expect(apply(club, closed.id, person.id)).rejects.toSatisfy(fails("admission_closed"));
    // P1.14: a member asks for a free place in a direct group; an owner admits it in one step.
    const direct = await team(club, { admissionMode: "direct", capacity: 2 });
    const entry = await apply(club, direct.id, person.id);
    expect(await entryRow(entry.id)).toMatchObject({ status: "waiting" });
    expect(await inGroup(direct.id, person.id)).toBe(false);
    await c.s.waitlists.admit(club.ctx, direct.id, entry.id, {});
    expect(await inGroup(direct.id, person.id)).toBe(true);
    // Full: the direct group takes a waiting list as before.
    await c.s.memberships.addGroupMember(club.ctx, direct.id, (await member(club)).id, "member");
    await apply(club, direct.id, (await member(club)).id);
  });

  it("lets someone outside the club apply to a public list, with a join request", async () => {
    const club = await buildClub(c.s, { joinPolicy: "approval" });
    const group = await team(club, { waitlistVisiblePublicly: true });
    const hidden = await team(club);
    const family = await buildFamily(c.s);
    const g = family.guardian;

    expect(await c.s.waitlists.clubOfGroup(actor(g.id), group.id)).toBe(club.id);
    await expect(c.s.waitlists.clubOfGroup(actor(g.id), hidden.id)).rejects.toSatisfy(
      fails("not_found"),
    );
    const open = await c.s.waitlists.openGroups(actor(g.id), club.id, false);
    expect(open.map((o) => o.id)).toEqual([group.id]);

    const { entry, joinRequestId } = await c.s.waitlists.apply(actor(g.id, club.id), group.id, {
      personId: family.child.id,
    });
    expect(joinRequestId).not.toBeNull();
    expect(entry.joinRequestId).toBe(joinRequestId);
    const { rows } = await c.t.query<{ status: string; preferred_group_ids: string[] }>(
      "admin",
      "SELECT status, preferred_group_ids FROM join_requests WHERE id = $1",
      [joinRequestId],
    );
    expect(rows[0]).toEqual({ status: "pending", preferred_group_ids: [group.id] });

    // Withdrawing the only entry withdraws the join request too.
    await c.s.waitlists.withdraw(actor(g.id), entry.id, self(g.id, [family.child.id]));
    const { rows: after } = await c.t.query<{ status: string }>(
      "admin",
      "SELECT status FROM join_requests WHERE id = $1",
      [joinRequestId],
    );
    expect(after[0]!.status).toBe("withdrawn");
  });

  it("hides the groups of invite-only clubs from outsiders", async () => {
    const club = await buildClub(c.s, { joinPolicy: "invite_only" });
    const group = await team(club, { waitlistVisiblePublicly: true });
    const outsider = await buildPerson(c.s);
    await expect(c.s.waitlists.clubOfGroup(actor(outsider.id), group.id)).rejects.toSatisfy(
      fails("not_found"),
    );
    expect(await c.s.waitlists.openGroups(actor(outsider.id), club.id, false)).toEqual([]);
  });
});

describe("the owners' decisions", () => {
  it("lists in fair order and needs a reason to skip anyone", async () => {
    const club = await buildClub(c.s);
    const group = await team(club, { capacity: 1 });
    const [a, b] = [await member(club), await member(club)];
    const first = await apply(club, group.id, a.id);
    const second = await apply(club, group.id, b.id);

    const page = await c.s.waitlists.list(club.ctx, group.id, { status: "open", limit: 50 });
    expect(page.items.map((e) => [e.id, e.position])).toEqual([
      [first.id, 1],
      [second.id, 2],
    ]);

    await expect(c.s.waitlists.offer(club.ctx, group.id, second.id, {})).rejects.toSatisfy(
      fails("out_of_order_reason_required"),
    );
    const offered = await c.s.waitlists.offer(club.ctx, group.id, second.id, {
      outOfOrderReason: "Sibling in the team",
      replyDays: 3,
    });
    expect(offered.status).toBe("offered");
    // The offer holds the only place.
    await expect(c.s.waitlists.offer(club.ctx, group.id, first.id, {})).rejects.toSatisfy(
      fails("group_full"),
    );
    // Withdrawn: back in line with the original time.
    await c.s.waitlists.withdrawOffer(club.ctx, group.id, second.id);
    const back = await entryRow(second.id);
    expect(back.status).toBe("waiting");
    expect(back.queued_at.getTime()).toBe(second.queuedAt.getTime());

    const view = await c.s.waitlists.clubView(club.ctx, {
      from: new Date(Date.now() - 86_400_000),
      cursor: null,
      limit: 50,
    });
    expect(view.groups.find((g) => g.id === group.id)).toMatchObject({ waiting: 2, offers: 0 });
  });

  it("ends an offer at the end of the reply day in the club's time zone", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    const entry = await apply(club, group.id, (await member(club)).id);
    const offered = await c.s.waitlists.offer(club.ctx, group.id, entry.id, { replyDays: 2 });
    const { rows } = await c.t.query<{ expected: Date }>(
      "admin",
      `SELECT ((((now() AT TIME ZONE time_zone)::date + 3)::timestamp) AT TIME ZONE time_zone) AS expected
       FROM clubs WHERE id = $1`,
      [club.id],
    );
    expect(offered.offerExpiresAt?.getTime()).toBe(rows[0]!.expected.getTime());
  });

  it("needs a reason for priority, and removes with a reason the applicant is told", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    const entry = await apply(club, group.id, (await member(club)).id);
    await expect(
      c.s.waitlists.update(club.ctx, group.id, entry.id, { priority: 1 }),
    ).rejects.toSatisfy(fails("priority_reason_required"));
    await c.s.waitlists.update(club.ctx, group.id, entry.id, {
      priority: 1,
      priorityReason: "sibling",
      ownerNote: "Brother in F2014",
    });
    expect(await auditActionsOf(c.t, entry.id)).toEqual(
      expect.arrayContaining(["group.waitlist.priority_changed", "group.waitlist.updated"]),
    );
    await c.s.waitlists.remove(club.ctx, group.id, entry.id, "no_reply");
    expect(await entryRow(entry.id)).toMatchObject({
      status: "removed",
      closed_reason: "no_reply",
    });
    const { rows } = await c.t.query<{ payload: { entryId: string } }>(
      "admin",
      "SELECT payload FROM outbox.events WHERE type = 'waitlist.entry.closed'",
    );
    expect(rows.map((r) => r.payload.entryId)).toContain(entry.id);
    await expect(c.s.waitlists.remove(club.ctx, group.id, entry.id, "other")).rejects.toSatisfy(
      fails("waitlist_entry_closed"),
    );
  });

  it("needs a reason to add a member past people waiting, listed for managers", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    await apply(club, group.id, (await member(club)).id);
    const direct = await member(club);
    await expect(
      c.s.memberships.addGroupMember(club.ctx, group.id, direct.id, "member"),
    ).rejects.toSatisfy(fails("queue_bypass_reason_required"));
    // Leaders never need one.
    await c.s.memberships.addGroupMember(club.ctx, group.id, direct.id, "head_coach");
    const row = await c.s.memberships.addGroupMember(club.ctx, group.id, direct.id, "member", {
      queueBypassReason: "Moved up from F2017",
    });
    const view = await c.s.waitlists.clubView(club.ctx, {
      from: new Date(Date.now() - 86_400_000),
      cursor: null,
      limit: 50,
    });
    expect(view.decisions).toContainEqual(
      expect.objectContaining({
        id: row.id,
        kind: "queue_bypass",
        reason: "Moved up from F2017",
        decidedByPersonId: club.manager.id,
      }),
    );
  });
});

describe("answering an offer and admission", () => {
  it("admits a member who accepts", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    const person = await member(club);
    const entry = await apply(club, group.id, person.id);
    await c.s.waitlists.offer(club.ctx, group.id, entry.id, {});
    const accepted = await c.s.waitlists.accept(actor(person.id), entry.id, self(person.id));
    expect(accepted.status).toBe("admitted");
    expect(await inGroup(group.id, person.id)).toBe(true);
    const { rows } = await c.t.query<{ type: string }>(
      "admin",
      "SELECT type FROM outbox.events WHERE payload->>'entryId' = $1 ORDER BY created_at",
      [entry.id],
    );
    expect(rows.map((r) => r.type)).toEqual([
      "waitlist.entry.created",
      "waitlist.offer.sent",
      "waitlist.admitted",
    ]);
  });

  it("refuses others, expired offers and entries that are not offered", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    const person = await member(club);
    const stranger = await buildPerson(c.s);
    const entry = await apply(club, group.id, person.id);
    await expect(
      c.s.waitlists.accept(actor(person.id), entry.id, self(person.id)),
    ).rejects.toSatisfy(fails("waitlist_entry_closed"));
    await c.s.waitlists.offer(club.ctx, group.id, entry.id, {});
    await expect(
      c.s.waitlists.accept(actor(stranger.id), entry.id, self(stranger.id)),
    ).rejects.toSatisfy(fails("not_found"));
    await c.t.db.withTenant(club.ctx, (tx) =>
      tx.execute(sql`UPDATE group_waitlist_entries SET offer_expires_at = now() - interval '1 minute'
        WHERE id = ${entry.id}`),
    );
    await expect(
      c.s.waitlists.accept(actor(person.id), entry.id, self(person.id)),
    ).rejects.toSatisfy(fails("offer_expired"));
  });

  it("closes the entry when the offer is declined", async () => {
    const club = await buildClub(c.s);
    const group = await team(club);
    const person = await member(club);
    const entry = await apply(club, group.id, person.id);
    await c.s.waitlists.offer(club.ctx, group.id, entry.id, {});
    await c.s.waitlists.decline(actor(person.id), entry.id, self(person.id));
    expect(await entryRow(entry.id)).toMatchObject({
      status: "declined",
      closed_reason: "declined",
    });
  });

  it("holds an outsider's accepted place until the club approves the join request", async () => {
    const club = await buildClub(c.s, { joinPolicy: "approval" });
    await c.s.clubs.updateSettings(club.ctx, { groupOwnersAdmitToClub: false });
    const group = await team(club, { waitlistVisiblePublicly: true });
    const outsider = await buildPerson(c.s);
    const { entry, joinRequestId } = await c.s.waitlists.apply(
      actor(outsider.id, club.id),
      group.id,
      { personId: outsider.id },
    );
    await c.s.waitlists.offer(club.ctx, group.id, entry.id, {});
    const accepted = await c.s.waitlists.accept(actor(outsider.id), entry.id, self(outsider.id));
    expect(accepted.status).toBe("accepted");
    expect(await inGroup(group.id, outsider.id)).toBe(false);
    const summary = await c.s.waitlists.summary(club.ctx, group.id);
    expect(summary).toMatchObject({ occupied: 1, accepted: 1 });

    await c.s.joinRequests.decide(club.ctx, joinRequestId!, { decision: "approve" });
    expect((await entryRow(entry.id)).status).toBe("admitted");
    expect(await inGroup(group.id, outsider.id)).toBe(true);
  });

  it("closes the entries when the club rejects the join request", async () => {
    const club = await buildClub(c.s, { joinPolicy: "approval" });
    const group = await team(club, { waitlistVisiblePublicly: true });
    const outsider = await buildPerson(c.s);
    const { entry, joinRequestId } = await c.s.waitlists.apply(
      actor(outsider.id, club.id),
      group.id,
      { personId: outsider.id },
    );
    await c.s.joinRequests.decide(club.ctx, joinRequestId!, { decision: "reject" });
    expect(await entryRow(entry.id)).toMatchObject({
      status: "removed",
      closed_reason: "join_request_rejected",
    });
  });

  it("admits to the club too when owners admit to the club (the default)", async () => {
    const club = await buildClub(c.s, { joinPolicy: "approval" });
    const group = await team(club, { waitlistVisiblePublicly: true });
    const outsider = await buildPerson(c.s);
    const { entry, joinRequestId } = await c.s.waitlists.apply(
      actor(outsider.id, club.id),
      group.id,
      { personId: outsider.id },
    );
    const admitted = await c.s.waitlists.admit(club.ctx, group.id, entry.id, {});
    expect(admitted.status).toBe("admitted");
    expect(await inGroup(group.id, outsider.id)).toBe(true);
    const { rows } = await c.t.query<{ status: string }>(
      "admin",
      "SELECT status FROM join_requests WHERE id = $1",
      [joinRequestId],
    );
    expect(rows[0]!.status).toBe("approved");
  });
});
