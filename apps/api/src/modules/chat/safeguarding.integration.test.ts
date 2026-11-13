// SPDX-License-Identifier: AGPL-3.0-only
// Child safety in chat (P2.1 part B, ADR 0047 rules 6, 7 and 11) through the
// API: one-tap reports (the reported person never learns who), safeguarding
// cases with the two-person rule (every read logged), hiding reported
// messages, mutes, moderation by a chat's managers, and a guardian's view
// of their child's chats (who is in them, never the messages).

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import {
  type ChatList,
  type ChatMessagePage,
  type ChatPage,
  type ChatReportDetail,
  type ChatReportMessages,
  type ChatReportPage,
} from "@clubadmin/shared";
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
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;

type Method = "GET" | "POST" | "DELETE";

async function api(
  personId: string,
  method: Method,
  url: string,
  options: { body?: unknown; mfa?: boolean } = {},
) {
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await devToken(personId, options.mfa ? { mfa: true } : {})}`,
      },
      ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
    } satisfies InjectOptions);
}
const detail = (res: { json: <T>() => T }) => res.json<{ detail?: string }>().detail;

let club: BuiltClub;
let groupId: string;
let coach: BuiltPerson;
let officer1: BuiltPerson;
let officer2: BuiltPerson;
let kid: BuiltFamily;
let other: BuiltFamily;
let channelId: string;
let coachMessageId: string;
let reportId: string;

const base = () => `/clubs/${club.id}`;
const chatUrl = (chatId: string) => `${base()}/chats/${chatId}`;
const caseUrl = (id: string) => `${base()}/safeguarding/reports/${id}`;
const officer = (personId: string, method: Method, url: string, body?: unknown) =>
  api(personId, method, url, { mfa: true, ...(body !== undefined ? { body } : {}) });

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
  await subscribeToFeatures(t, [club.id], ["chat"]);
  groupId = (await s.groups.createGroup(club.ctx, { name: "P2014", kind: "team" })).id;
  coach = await buildPerson(s);
  officer1 = await buildPerson(s);
  officer2 = await buildPerson(s);
  kid = await buildFamily(s, { club, childBirthDate: "2014-03-01" });
  other = await buildFamily(s, { club, childBirthDate: "2014-06-01" });
  for (const p of [coach, officer1, officer2]) await s.memberships.addMember(club.ctx, p.id);
  await s.memberships.addToGroup(club.ctx, groupId, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, groupId, kid.child.id, "member");
  await s.memberships.addToGroup(club.ctx, groupId, other.child.id, "member");
  await s.roles.assignRole(club.ctx, officer1.id, "safeguarding_officer");
  await s.roles.assignRole(club.ctx, officer2.id, "safeguarding_officer");
  // The group's channel (the coach and two children; the rule adds their guardians).
  const list = (await api(coach.id, "GET", `${base()}/groups/${groupId}/chats`)).json<ChatList>();
  channelId = list.items[0]!.id;
  const sent = await api(coach.id, "POST", `${chatUrl(channelId)}/messages`, {
    body: { body: "Snapchat me privately" },
  });
  coachMessageId = sent.json<{ id: string }>().id;
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("reporting (rule 7)", () => {
  it("a child reports a message with one tap", async () => {
    const res = await api(kid.child.id, "POST", `${chatUrl(channelId)}/reports`, {
      body: { messageId: coachMessageId, reason: "unsafe_contact" },
    });
    expect(res.statusCode).toBe(201);
    reportId = res.json<{ id: string }>().id;
  });

  it("nobody reports their own message, and outsiders cannot report", async () => {
    const own = await api(coach.id, "POST", `${chatUrl(channelId)}/reports`, {
      body: { messageId: coachMessageId, reason: "other" },
    });
    expect(detail(own)).toBe("chat_report_own");
    const stranger = await buildPerson(s);
    const res = await api(stranger.id, "POST", `${chatUrl(channelId)}/reports`, {
      body: { reason: "other" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("the reported person (and other members) cannot see reports or who reported", async () => {
    for (const p of [coach.id, kid.guardian.id]) {
      const res = await api(p, "GET", `${base()}/safeguarding/reports`, { mfa: true });
      expect(res.statusCode).toBe(403);
    }
  });

  it("the club's safeguarding officers are told (an outbox event, IDs only)", async () => {
    const events = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM outbox.events WHERE type = 'chat.report.created'
       AND payload->>'reportId' = $1`,
      [reportId],
    );
    expect(events.rows[0]!.n).toBe(1);
  });
});

describe("safeguarding cases (two-person rule)", () => {
  it("officers see the case, with the reporter, but need a second factor", async () => {
    const without = await api(officer1.id, "GET", `${base()}/safeguarding/reports`);
    expect(without.statusCode).toBe(403);
    const page = (
      await officer(officer1.id, "GET", `${base()}/safeguarding/reports`)
    ).json<ChatReportPage>();
    const item = page.items.find((r) => r.id === reportId)!;
    expect(item.reason).toBe("unsafe_contact");
    expect(item.hasChildren).toBe(true);
    expect(item.reportedPerson?.kind).toBe("person");
    const d = (await officer(officer1.id, "GET", caseUrl(reportId))).json<ChatReportDetail>();
    expect(d.reporter?.kind === "person" && d.reporter.person.id).toBe(kid.child.id);
    expect(d.canRead).toBe(false);
  });

  it("reading needs a second officer's confirmation; the asker cannot confirm", async () => {
    const before = await officer(officer1.id, "GET", `${caseUrl(reportId)}/messages`);
    expect(detail(before)).toBe("chat_read_not_confirmed");
    const asked = await officer(officer1.id, "POST", `${caseUrl(reportId)}/reads`, {});
    expect(asked.statusCode).toBe(201);
    const readId = asked.json<{ id: string }>().id;
    // Asking again returns the same request.
    const again = await officer(officer1.id, "POST", `${caseUrl(reportId)}/reads`, {});
    expect(again.json<{ id: string }>().id).toBe(readId);
    const self = await officer(
      officer1.id,
      "POST",
      `${caseUrl(reportId)}/reads/${readId}/confirm`,
      {},
    );
    expect(detail(self)).toBe("chat_read_not_confirmable");
    const d2 = (await officer(officer2.id, "GET", caseUrl(reportId))).json<ChatReportDetail>();
    expect(d2.canConfirm).toBe(readId);
    const confirmed = await officer(
      officer2.id,
      "POST",
      `${caseUrl(reportId)}/reads/${readId}/confirm`,
      {},
    );
    expect(confirmed.statusCode).toBe(201);
  });

  it("both may then read the chat, hidden texts included, and every read is logged", async () => {
    for (const p of [officer1.id, officer2.id]) {
      const res = await officer(p, "GET", `${caseUrl(reportId)}/messages`);
      expect(res.statusCode).toBe(200);
      const page = res.json<ChatReportMessages>();
      expect(page.items.some((m) => m.recordBody === "Snapchat me privately")).toBe(true);
    }
    const { rows } = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM audit.events
       WHERE action = 'chat.report.read' AND resource_id = $1`,
      [reportId],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("an officer hides the reported message: kept for the record, hidden for the chat", async () => {
    const res = await officer(officer1.id, "POST", `${caseUrl(reportId)}/hide`, {
      messageId: coachMessageId,
    });
    expect(res.statusCode).toBe(201);
    const page = (
      await api(kid.child.id, "GET", `${chatUrl(channelId)}/messages`)
    ).json<ChatMessagePage>();
    const m = page.items.find((x) => x.id === coachMessageId)!;
    expect(m.hidden).toBe("moderator");
    expect(m.body).toBe("");
    const record = (
      await officer(officer1.id, "GET", `${caseUrl(reportId)}/messages`)
    ).json<ChatReportMessages>();
    expect(record.items.find((x) => x.id === coachMessageId)?.recordBody).toBe(
      "Snapchat me privately",
    );
  });

  it("a muted member writes nothing until the mute is lifted; the person is told", async () => {
    const muted = await officer(officer1.id, "POST", `${base()}/safeguarding/mutes`, {
      personId: coach.id,
      hours: 24,
      reportId,
    });
    expect(muted.statusCode).toBe(201);
    const muteId = muted.json<{ id: string }>().id;
    const blocked = await api(coach.id, "POST", `${chatUrl(channelId)}/messages`, {
      body: { body: "Hello?" },
    });
    expect(detail(blocked)).toBe("chat_muted");
    const list = (await officer(officer2.id, "GET", `${base()}/safeguarding/mutes`)).json<{
      items: { id: string }[];
    }>();
    expect(list.items.map((x) => x.id)).toContain(muteId);
    const events = await t.query<{ n: number }>(
      "admin",
      `SELECT count(*)::int AS n FROM outbox.events WHERE type = 'chat.member.muted'
       AND payload->>'personId' = $1`,
      [coach.id],
    );
    expect(events.rows[0]!.n).toBe(1);
    expect(
      (await officer(officer2.id, "DELETE", `${base()}/safeguarding/mutes/${muteId}`)).statusCode,
    ).toBe(200);
    const ok = await api(coach.id, "POST", `${chatUrl(channelId)}/messages`, {
      body: { body: "Training at five" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("closes the case once", async () => {
    const res = await officer(officer1.id, "POST", `${caseUrl(reportId)}/close`, {
      outcome: "message_hidden",
      note: "Talked with the coach and the parents.",
    });
    expect(res.statusCode).toBe(201);
    const again = await officer(officer1.id, "POST", `${caseUrl(reportId)}/close`, {
      outcome: "no_action",
    });
    expect(detail(again)).toBe("chat_report_closed");
    const d = (await officer(officer2.id, "GET", caseUrl(reportId))).json<ChatReportDetail>();
    expect(d.report.status).toBe("closed");
    expect(d.report.outcome).toBe("message_hidden");
  });
});

describe("moderation by a chat's managers (rule 11)", () => {
  it("the creator hides someone's message; a member cannot", async () => {
    const created = await api(coach.id, "POST", `${base()}/groups/${groupId}/chats`, {
      body: { name: "Matchinfo", visibility: "open", memberIds: [kid.child.id] },
    });
    const chatId = created.json<{ id: string }>().id;
    const sent = await api(kid.child.id, "POST", `${chatUrl(chatId)}/messages`, {
      body: { body: "something mean" },
    });
    const messageId = sent.json<{ id: string }>().id;
    const byKid = await api(
      kid.child.id,
      "POST",
      `${chatUrl(chatId)}/messages/${messageId}/moderate`,
      {
        body: {},
      },
    );
    expect(byKid.statusCode).toBe(403);
    const byCoach = await api(
      coach.id,
      "POST",
      `${chatUrl(chatId)}/messages/${messageId}/moderate`,
      {
        body: {},
      },
    );
    expect(byCoach.statusCode).toBe(201);
    const page = (
      await api(kid.child.id, "GET", `${chatUrl(chatId)}/messages`)
    ).json<ChatMessagePage>();
    expect(page.items.find((m) => m.id === messageId)?.hidden).toBe("moderator");
  });
});

describe("a guardian's view of their child's chats (rule 6)", () => {
  it("lists the child's chats for a parent; not for others", async () => {
    const page = (
      await api(kid.guardian.id, "GET", `/me/wards/${kid.child.id}/chats`)
    ).json<ChatPage>();
    expect(page.items.map((c) => c.id)).toContain(channelId);
    const notTheirs = await api(other.guardian.id, "GET", `/me/wards/${kid.child.id}/chats`);
    expect(notTheirs.statusCode).toBe(404);
  });

  it("shows no message excerpt of chats the guardian is not in", async () => {
    const chat = await api(kid.child.id, "POST", `${base()}/groups/${groupId}/chats`, {
      body: { name: "Kids only", visibility: "closed", memberIds: [other.child.id] },
    });
    const chatId = chat.json<{ id: string }>().id;
    await api(kid.child.id, "POST", `${chatUrl(chatId)}/messages`, { body: { body: "secret" } });
    const page = (
      await api(kid.guardian.id, "GET", `/me/wards/${kid.child.id}/chats`)
    ).json<ChatPage>();
    const item = page.items.find((c) => c.id === chatId)!;
    expect(item.lastMessage).toBeNull();
    expect(item.unreadCount).toBe(0);
  });
});
