// SPDX-License-Identifier: AGPL-3.0-only
// Announcements (P2.3, ADR 0053) through the API: a group's and the club's
// announcements reach their audience (guardians included) on the boards and
// nobody else; group senders stay within their group; drafts, scheduling,
// editing after sending, withdrawing and deleting; read marks; the
// composer's counts, what happened to a sent one (counts only), the
// per-club email limit, the audit log and tenant isolation.

import { sql } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type {
  AnnouncementArchive,
  AnnouncementBoard,
  AnnouncementDetail,
  AnnouncementPreview,
  AnnouncementRecipients,
} from "@clubadmin/shared";
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function api(personId: string, method: Method, url: string, body?: unknown) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await devToken(personId)}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let other: BuiltClub;
let manager: BuiltPerson;
let coach: BuiltPerson;
let outsider: BuiltPerson;
let family: BuiltFamily;
let otherFamily: BuiltFamily;
let teamId: string;
let otherTeamId: string;

const base = () => `/clubs/${club.id}`;
const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function create(personId: string, url: string, body: Record<string, unknown>) {
  const res = await api(personId, "POST", url, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

const board = async (personId: string) =>
  (await api(personId, "GET", "/me/announcements")).json<AnnouncementBoard>();
const titles = (b: AnnouncementBoard) => [...b.pinned, ...b.items].map((a) => a.title);

async function outboxTypes(announcementId: string): Promise<string[]> {
  const { rows } = await t.query<{ type: string }>(
    "admin",
    "SELECT type FROM outbox.events WHERE payload->>'announcementId' = $1 ORDER BY created_at, id",
    [announcementId],
  );
  return rows.map((r) => r.type);
}

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    // One email a day: any announcement by email to the team passes it.
    ANNOUNCEMENT_EMAILS_PER_CLUB_DAY: "1",
    ...NO_RATE_LIMITS,
  });
  club = await buildClub(s);
  other = await buildClub(s);
  manager = club.manager;
  teamId = (await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" })).id;
  otherTeamId = (await s.groups.createGroup(club.ctx, { name: "P2012", kind: "team" })).id;
  coach = await buildPerson(s);
  outsider = await buildPerson(s);
  family = await buildFamily(s, { club, childBirthDate: "2015-04-01" });
  otherFamily = await buildFamily(s, { club, childBirthDate: "2012-04-01" });
  await s.memberships.addMember(club.ctx, coach.id);
  await s.memberships.addToGroup(club.ctx, teamId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, teamId, family.child.id, "member");
  await s.memberships.addToGroup(club.ctx, otherTeamId, otherFamily.child.id, "member");
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("announcements", () => {
  let teamNotice: string;
  let meeting: string;

  it("a group's announcement reaches its members and guardians, nobody else", async () => {
    teamNotice = await create(coach.id, `${base()}/groups/${teamId}/announcements`, {
      title: "Planen är stängd",
      body: "Ingen träning **tisdag**.\n\n- Vi ses torsdag",
      channels: ["board", "push"],
      send: true,
    });
    expect(titles(await board(family.guardian.id))).toEqual(["Planen är stängd"]);
    expect(titles(await board(family.coGuardian.id))).toEqual(["Planen är stängd"]);
    expect(titles(await board(otherFamily.guardian.id))).toEqual([]);
    // The group's own board, and one announcement.
    const group = await api(family.guardian.id, "GET", `${base()}/groups/${teamId}/announcements`);
    expect(group.statusCode).toBe(200);
    expect(titles(group.json<AnnouncementBoard>())).toEqual(["Planen är stängd"]);
    const one = await api(family.guardian.id, "GET", `${base()}/announcements/${teamNotice}`);
    expect(one.statusCode).toBe(200);
    const shown = one.json<AnnouncementDetail>();
    expect(shown.announcement).toMatchObject({
      status: "sent",
      read: false,
      canManage: false,
      groupName: "F2015",
    });
    expect(shown.announcement.sender?.id).toBe(coach.id);
    expect(shown.audience).toEqual([
      { kind: "group", groupId: teamId, groupName: "F2015", roleIds: [] },
    ]);
    // Outside its audience it does not exist.
    for (const id of [otherFamily.guardian.id, outsider.id, other.manager.id]) {
      const res = await api(id, "GET", `${base()}/announcements/${teamNotice}`);
      expect(res.statusCode).toBe(404);
    }
    expect(await outboxTypes(teamNotice)).toEqual(["announcement.sent"]);
    expect(await auditActionsOf(t, teamNotice)).toEqual([
      "announcement.created",
      "announcement.published",
    ]);
  });

  it("marks read on the board", async () => {
    const read = await api(
      family.guardian.id,
      "POST",
      `${base()}/announcements/${teamNotice}/read`,
    );
    expect(read.statusCode).toBe(204);
    expect((await board(family.guardian.id)).items[0]?.read).toBe(true);
    // Each guardian has their own mark.
    expect((await board(family.coGuardian.id)).items[0]?.read).toBe(false);
  });

  it("keeps a group's senders within their group, and the club's to its senders", async () => {
    const outside = await api(coach.id, "POST", `${base()}/groups/${teamId}/announcements`, {
      title: "Till alla",
      body: "Hej",
      audience: [{ kind: "club" }],
      channels: ["board"],
    });
    expect(outside.statusCode).toBe(400);
    expect(detail(outside)).toBe("audience_outside_group");
    const otherTeam = await api(coach.id, "POST", `${base()}/groups/${otherTeamId}/announcements`, {
      title: "Till P2012",
      body: "Hej",
      channels: ["board"],
    });
    expect(otherTeam.statusCode).toBe(403);
    const clubWide = await api(coach.id, "POST", `${base()}/announcements`, {
      title: "Till klubben",
      body: "Hej",
      channels: ["board"],
    });
    expect(clubWide.statusCode).toBe(403);
    const publicOne = await api(manager.id, "POST", `${base()}/announcements`, {
      title: "Publikt",
      body: "Hej",
      audience: [{ kind: "public" }],
      channels: ["board"],
    });
    expect(publicOne.statusCode).toBe(400);
  });

  it("pins the club's announcement on top of everyone's board", async () => {
    meeting = await create(manager.id, `${base()}/announcements`, {
      title: "Årsmöte 12 mars",
      body: "Välkomna till årsmötet.",
      channels: ["board", "push"],
      important: true,
      pinnedUntil: future(24 * 30),
      send: true,
    });
    const b = await board(otherFamily.guardian.id);
    expect(b.pinned.map((a) => a.title)).toEqual(["Årsmöte 12 mars"]);
    expect(b.items.map((a) => a.title)).toEqual([]);
    const own = await board(family.guardian.id);
    expect(own.pinned.map((a) => a.title)).toEqual(["Årsmöte 12 mars"]);
    expect(own.items.map((a) => a.title)).toEqual(["Planen är stängd"]);
    expect(own.pinned[0]).toMatchObject({ important: true, pinned: true });
    // A person outside the club has an empty board.
    expect(titles(await board(outsider.id))).toEqual([]);
  });

  it("edits after sending only the text, marked edited", async () => {
    const edit = await api(manager.id, "PATCH", `${base()}/announcements/${meeting}`, {
      title: "Årsmöte 13 mars",
    });
    expect(edit.statusCode).toBe(204);
    const shown = (
      await api(family.guardian.id, "GET", `${base()}/announcements/${meeting}`)
    ).json<AnnouncementDetail>();
    expect(shown.announcement.title).toBe("Årsmöte 13 mars");
    expect(shown.announcement.editedAt).not.toBeNull();
    const audience = await api(manager.id, "PATCH", `${base()}/announcements/${meeting}`, {
      audience: [{ kind: "group", groupId: teamId }],
    });
    expect(audience.statusCode).toBe(409);
    expect(detail(audience)).toBe("announcement_already_sent");
    // The coach did not write it and does not send to the club.
    const coachEdit = await api(coach.id, "PATCH", `${base()}/announcements/${meeting}`, {
      title: "x",
    });
    expect(coachEdit.statusCode).toBe(403);
  });

  it("keeps drafts and scheduled ones off the board, in the archive", async () => {
    const draft = await create(manager.id, `${base()}/announcements`, {
      title: "Utkast",
      body: "Inte klart",
      channels: ["board"],
    });
    const scheduled = await create(manager.id, `${base()}/announcements`, {
      title: "Senare",
      body: "Kommer i morgon",
      channels: ["board"],
      scheduledAt: future(24),
      send: true,
    });
    expect(titles(await board(family.guardian.id))).not.toContain("Utkast");
    expect(titles(await board(family.guardian.id))).not.toContain("Senare");
    const archive = (
      await api(manager.id, "GET", `${base()}/announcements`)
    ).json<AnnouncementArchive>();
    const status = new Map(archive.items.map((a) => [a.title, a.status]));
    expect(status.get("Utkast")).toBe("draft");
    expect(status.get("Senare")).toBe("scheduled");
    expect(status.get("Årsmöte 13 mars")).toBe("sent");
    // A guardian may not read a draft; nor does the archive exist for them.
    expect(
      (await api(family.guardian.id, "GET", `${base()}/announcements/${draft}`)).statusCode,
    ).toBe(404);
    expect((await api(family.guardian.id, "GET", `${base()}/announcements`)).statusCode).toBe(403);
    // A schedule in the past is refused; sending the draft now puts it on the board.
    const past = await api(manager.id, "PATCH", `${base()}/announcements/${draft}`, {
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      send: true,
    });
    expect(detail(past)).toBe("announcement_schedule_past");
    expect(
      (await api(manager.id, "PATCH", `${base()}/announcements/${draft}`, { send: true }))
        .statusCode,
    ).toBe(204);
    expect(titles(await board(family.guardian.id))).toContain("Utkast");
    // Moving the scheduled one back to a draft.
    expect(
      (await api(manager.id, "PATCH", `${base()}/announcements/${scheduled}`, { send: false }))
        .statusCode,
    ).toBe(204);
    const again = (
      await api(manager.id, "GET", `${base()}/announcements/${scheduled}`)
    ).json<AnnouncementDetail>();
    expect(again.announcement.status).toBe("draft");
  });

  it("counts the audience before sending and what happened after, never names", async () => {
    const preview = await api(
      coach.id,
      "POST",
      `${base()}/groups/${teamId}/announcements/preview`,
      {
        audience: [{ kind: "group", groupId: teamId }],
      },
    );
    expect(preview.statusCode).toBe(200);
    // The coach, the child and both guardians.
    expect(preview.json<AnnouncementPreview>()).toMatchObject({ recipients: 4, withEmail: 3 });
    const recipients = await api(
      coach.id,
      "GET",
      `${base()}/announcements/${teamNotice}/recipients`,
    );
    expect(recipients.statusCode).toBe(200);
    expect(recipients.json<AnnouncementRecipients>()).toMatchObject({ read: 1 });
    const guardian = await api(
      family.guardian.id,
      "GET",
      `${base()}/announcements/${teamNotice}/recipients`,
    );
    expect(guardian.statusCode).toBe(403);
  });

  it("refuses email past the club's daily limit", async () => {
    const res = await api(coach.id, "POST", `${base()}/groups/${teamId}/announcements`, {
      title: "Med e-post",
      body: "Hej",
      channels: ["board", "email"],
      send: true,
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toBe("announcement_email_limit");
  });

  it("withdraws and deletes", async () => {
    const withdrawn = await api(coach.id, "POST", `${base()}/announcements/${teamNotice}/withdraw`);
    expect(withdrawn.statusCode).toBe(204);
    expect(titles(await board(family.guardian.id))).not.toContain("Planen är stängd");
    expect(
      (await api(family.guardian.id, "GET", `${base()}/announcements/${teamNotice}`)).statusCode,
    ).toBe(404);
    expect(await outboxTypes(teamNotice)).toEqual(["announcement.sent", "announcement.withdrawn"]);
    expect(
      (await api(coach.id, "PATCH", `${base()}/announcements/${teamNotice}`, { title: "x" }))
        .statusCode,
    ).toBe(409);
    const removed = await api(manager.id, "DELETE", `${base()}/announcements/${meeting}`);
    expect(removed.statusCode).toBe(204);
    expect(titles(await board(family.guardian.id))).not.toContain("Årsmöte 13 mars");
    expect(await auditActionsOf(t, meeting)).toContain("announcement.deleted");
    const { rows } = await t.db.withSystem("test", { clubId: club.id }, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM public.announcement_reads WHERE announcement_id = ${meeting}::uuid`),
    );
    expect(rows[0]!.n).toBe(0);
  });
});
