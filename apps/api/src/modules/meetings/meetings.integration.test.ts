// SPDX-License-Identifier: AGPL-3.0-only
// Meetings and tasks (P2.4 part B) through the API: the country pack's and
// the club's agenda templates, a board meeting's agenda (items kept by ID,
// minutes, decisions, papers read by the meeting's readers, action items),
// the annual meeting's agenda on an event, the minutes assembled into a
// governing document (and again as its draft), and "Mina uppgifter".

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { Agenda, AgendaTemplateList, GoverningDocument, MyTaskPage } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { subscribeToFeatures } from "../../testing/billing.ts";
import {
  buildClub,
  buildPerson,
  type BuiltClub,
  type BuiltPerson,
} from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

type Method = "GET" | "POST" | "PUT";

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
let chair: BuiltPerson;
let boardMember: BuiltPerson;
let member: BuiltPerson;
let outsider: BuiltPerson;
let boardId: string;
let meetingId: string;
let annualId: string;
let seriesId: string;
let paperId: string;

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
  await subscribeToFeatures(t, [club.id], ["documents"]);
  chair = await buildPerson(s);
  boardMember = await buildPerson(s);
  member = await buildPerson(s);
  outsider = await buildPerson(s);
  for (const p of [chair, boardMember, member]) await s.memberships.addMember(club.ctx, p.id);
  await s.roles.assignRole(club.ctx, chair.id, "chair");
  boardId = (await s.groups.createGroup(club.ctx, { name: "Styrelsen", kind: "board" })).id;
  await s.memberships.addToGroup(club.ctx, boardId, chair.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, boardId, boardMember.id, "member");
  meetingId = (
    await s.activities.createActivity(club.ctx, boardId, {
      kind: "meeting",
      title: "Styrelsemöte 3",
      startsAt: `${day(-1)}T17:00:00Z`,
      endsAt: `${day(-1)}T19:00:00Z`,
    })
  ).activity.id;
  annualId = (
    await s.events.createEvent(club.ctx, {
      title: "Årsmöte",
      audience: "club",
      startsAt: `${day(10)}T17:00:00Z`,
      endsAt: `${day(10)}T19:00:00Z`,
      publish: true,
    })
  ).event.id;
  const chairCtx = { ...club.ctx, personId: chair.id };
  seriesId = await s.governing.createSeries(chairCtx, {
    name: "Styrelseprotokoll",
    seriesKind: "board_minutes",
    groupId: boardId,
  });
  // A paper: a file of the board's own series would do; a governing draft is a document too.
  paperId = (
    await s.governing.create(chairCtx, { seriesId, name: "Budgetförslag", body: "Budget." })
  ).id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("agenda templates", () => {
  it("start from the country pack's and are the club's own once saved", async () => {
    const list = (
      await api(chair.id, "GET", `/clubs/${club.id}/agenda-templates`)
    ).json<AgendaTemplateList>();
    const board = list.items.find((x) => x.packKey === "se.board_meeting");
    expect(board?.items[0]?.title).toBe("Mötets öppnande");
    expect(list.canManage).toBe(true);

    const saved = await api(chair.id, "PUT", `/clubs/${club.id}/agenda-templates`, {
      templates: [{ meetingKind: "board_meeting", name: "Vårt styrelsemöte", items: board!.items }],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<AgendaTemplateList>().items[0]).toMatchObject({
      packKey: null,
      name: "Vårt styrelsemöte",
    });
    // A board member reads them, but does not change them.
    const forMember = await api(boardMember.id, "GET", `/clubs/${club.id}/agenda-templates`);
    expect(forMember.json<AgendaTemplateList>().canManage).toBe(false);
    expect(
      (await api(boardMember.id, "PUT", `/clubs/${club.id}/agenda-templates`, { templates: [] }))
        .statusCode,
    ).toBe(403);
  });
});

describe("a board meeting", () => {
  let agenda: Agenda;

  it("gets its agenda from the meeting's editor; board members read it", async () => {
    const res = await api(chair.id, "PUT", `/activities/${meetingId}/agenda`, {
      items: [
        { title: "Mötets öppnande" },
        { title: "Ekonomi", presenterPersonId: chair.id, durationMinutes: 15, paperIds: [paperId] },
        { title: "Övriga frågor" },
      ],
    });
    expect(res.statusCode).toBe(200);
    agenda = res.json<Agenda>();
    expect(agenda.items.map((i) => [i.position, i.title])).toEqual([
      [1, "Mötets öppnande"],
      [2, "Ekonomi"],
      [3, "Övriga frågor"],
    ]);
    expect(agenda.items[1]?.presenter?.id).toBe(chair.id);
    expect(agenda.items[1]?.papers).toEqual([{ id: paperId, name: "Budgetförslag" }]);

    const forBoard = await api(boardMember.id, "GET", `/activities/${meetingId}/agenda`);
    expect(forBoard.json<Agenda>().canEdit).toBe(false);
    expect(
      (await api(boardMember.id, "PUT", `/activities/${meetingId}/agenda`, { items: [] }))
        .statusCode,
    ).toBe(403);
    expect((await api(outsider.id, "GET", `/activities/${meetingId}/agenda`)).statusCode).toBe(404);
    // A presenter outside the club is refused.
    const stranger = await api(chair.id, "PUT", `/activities/${meetingId}/agenda`, {
      items: [{ title: "X", presenterPersonId: outsider.id }],
    });
    expect(detail(stranger)).toBe("agenda_person_invalid");
  });

  it("takes minutes, decisions and action items per item during the meeting", async () => {
    const [opening, economy, other] = agenda.items;
    const res = await api(chair.id, "PUT", `/activities/${meetingId}/agenda`, {
      items: [
        { id: opening!.id, title: opening!.title, minutes: "Ordföranden öppnade mötet." },
        {
          id: economy!.id,
          title: economy!.title,
          presenterPersonId: chair.id,
          paperIds: [paperId],
          minutes: "Kassören redogjorde för budgeten.",
          decisions: ["Styrelsen fastställer budgeten."],
          actions: [
            {
              title: "Skicka budgeten till revisorerna",
              dueDate: day(14),
              assignees: [{ personId: boardMember.id }],
            },
          ],
        },
        { id: other!.id, title: other!.title },
      ],
    });
    expect(res.statusCode).toBe(200);
    agenda = res.json<Agenda>();
    const item = agenda.items[1]!;
    expect(item.decisions.map((d) => d.text)).toEqual(["Styrelsen fastställer budgeten."]);
    expect(item.actions[0]).toMatchObject({ title: "Skicka budgeten till revisorerna" });
    expect(item.actions[0]?.assignees.map((a) => [a.person?.id, a.status])).toEqual([
      [boardMember.id, "planned"],
    ]);
    expect(await auditActionsOf(t, meetingId)).toContain("meeting.agenda.updated");
  });

  it("is in the assignee's Mina uppgifter, who marks it done", async () => {
    const page = (await api(boardMember.id, "GET", "/me/tasks")).json<MyTaskPage>();
    expect(page.items).toHaveLength(1);
    const task = page.items[0]!;
    expect(task).toMatchObject({
      title: "Skicka budgeten till revisorerna",
      dueDate: day(14),
      status: "planned",
      groupName: "Styrelsen",
      meeting: { kind: "activity", id: meetingId, title: "Styrelsemöte 3" },
    });
    expect(task.person?.id).toBe(boardMember.id);
    // Someone else cannot mark it.
    expect(
      (
        await api(member.id, "POST", `/me/task-assignments/${task.assignmentId}/status`, {
          status: "done",
        })
      ).statusCode,
    ).toBe(404);
    const done = await api(
      boardMember.id,
      "POST",
      `/me/task-assignments/${task.assignmentId}/status`,
      { status: "done" },
    );
    expect(done.statusCode).toBe(204);
    expect((await api(boardMember.id, "GET", "/me/tasks")).json<MyTaskPage>().items).toEqual([]);
    const closed = (await api(boardMember.id, "GET", "/me/tasks?status=closed")).json<MyTaskPage>();
    expect(closed.items.map((x) => x.status)).toEqual(["done"]);
    // The agenda shows it done; saving the agenda again keeps the status.
    const again = (await api(chair.id, "GET", `/activities/${meetingId}/agenda`)).json<Agenda>();
    expect(again.items[1]?.actions[0]?.assignees[0]?.status).toBe("done");
  });

  it("is assembled into minutes in the board's series, and again as its draft", async () => {
    const first = await api(chair.id, "POST", `/activities/${meetingId}/minutes`, {});
    expect(detail(first)).toBe("minutes_series_required");
    const res = await api(chair.id, "POST", `/activities/${meetingId}/minutes`, { seriesId });
    expect(res.statusCode).toBe(201);
    const { documentId, versionId } = res.json<{ documentId: string; versionId: string }>();

    const doc = (
      await api(chair.id, "GET", `/clubs/${club.id}/governing-documents/${documentId}`)
    ).json<GoverningDocument>();
    expect(doc.status).toBe("draft");
    expect(doc.series.id).toBe(seriesId);
    const body = doc.draft!.body;
    expect(body).toContain("# Protokoll: Styrelsemöte 3");
    expect(body).toContain("## § 2 Ekonomi");
    expect(body).toContain("Kassören redogjorde för budgeten.");
    expect(body).toContain("- Styrelsen fastställer budgeten.");
    expect(body).toContain(`Skicka budgeten till revisorerna (senast ${day(14)})`);
    // No names in the text (ADR 0022): the assignee is on the agenda only.
    expect(body).not.toContain(boardMember.id);

    const again = await api(chair.id, "POST", `/activities/${meetingId}/minutes`, {});
    expect(again.json<{ documentId: string; versionId: string }>()).toEqual({
      documentId,
      versionId,
    });
    expect(
      (await api(chair.id, "GET", `/activities/${meetingId}/agenda`)).json<Agenda>()
        .minutesDocumentId,
    ).toBe(documentId);
    expect(await auditActionsOf(t, meetingId)).toContain("meeting.minutes.assembled");
  });

  it("removing an item removes its decisions and action items", async () => {
    const res = await api(chair.id, "PUT", `/activities/${meetingId}/agenda`, {
      items: [{ id: agenda.items[0]!.id, title: "Mötets öppnande" }],
    });
    expect(res.json<Agenda>().items).toHaveLength(1);
    expect(
      (await api(boardMember.id, "GET", "/me/tasks?status=closed")).json<MyTaskPage>().items,
    ).toEqual([]);
  });
});

describe("the annual meeting", () => {
  it("is an event for the club with the same agenda, read by every member", async () => {
    const res = await api(club.manager.id, "PUT", `/events/${annualId}/agenda`, {
      items: [{ title: "Mötets öppnande" }, { title: "Val av ordförande" }],
    });
    expect(res.statusCode).toBe(200);
    const forMember = (await api(member.id, "GET", `/events/${annualId}/agenda`)).json<Agenda>();
    expect(forMember.meeting).toMatchObject({ kind: "event", title: "Årsmöte" });
    expect(forMember.items.map((i) => i.title)).toEqual(["Mötets öppnande", "Val av ordförande"]);
    expect(forMember.canEdit).toBe(false);
  });
});
