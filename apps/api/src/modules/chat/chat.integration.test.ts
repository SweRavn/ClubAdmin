// SPDX-License-Identifier: AGPL-3.0-only
// Chat (P2.1, ADR 0047) through the API: the group's default channel with
// the guardian rule, channels open and closed, children's chats, guardians
// and leaders joining visibly, direct messages and their rules, messages
// with edits kept, hiding, reactions, read receipts, the offline resend,
// protected people offered, acting on behalf, tenant isolation, erasure,
// and the real-time connection.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import {
  type ChatDetail,
  type ChatList,
  type ChatMessage,
  type ChatMessagePage,
  type ChatPage,
  ON_BEHALF_OF_HEADER,
  type RealtimeTicket,
  uuidv7,
} from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

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

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

async function api(
  personId: string,
  method: Method,
  url: string,
  options: { body?: unknown; onBehalfOf?: string } = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await devToken(personId)}`,
  };
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

/** A team: a coach, two children with their families, an adult player and a supporter. */
interface Team {
  club: BuiltClub;
  groupId: string;
  coach: BuiltPerson;
  assistant: BuiltPerson;
  kid1: BuiltFamily;
  kid2: BuiltFamily;
  /** An adult in the group who leads nothing (a grandparent watching). */
  supporter: BuiltPerson;
  /** A member of the club outside the group. */
  outsider: BuiltPerson;
}
let team: Team;

async function buildTeam(): Promise<Team> {
  const club = await buildClub(s);
  // CI also runs with billing on: the club's plan includes chat.
  await subscribeToFeatures(t, [club.id], ["chat"]);
  const group = await s.groups.createGroup(club.ctx, { name: "F2015", kind: "team" });
  const coach = await buildPerson(s);
  const assistant = await buildPerson(s);
  const supporter = await buildPerson(s);
  const outsider = await buildPerson(s);
  const kid1 = await buildFamily(s, { club, childBirthDate: "2015-04-01" });
  const kid2 = await buildFamily(s, { club, childBirthDate: "2015-09-01" });
  for (const p of [coach, assistant, supporter, outsider]) {
    await s.memberships.addMember(club.ctx, p.id);
  }
  await s.memberships.addToGroup(club.ctx, group.id, coach.id, "head_coach");
  await s.memberships.addToGroup(club.ctx, group.id, assistant.id, "assistant_coach");
  await s.memberships.addToGroup(club.ctx, group.id, supporter.id, "member");
  await s.memberships.addToGroup(club.ctx, group.id, kid1.child.id, "member");
  await s.memberships.addToGroup(club.ctx, group.id, kid2.child.id, "member");
  return { club, groupId: group.id, coach, assistant, kid1, kid2, supporter, outsider };
}

const base = () => `/clubs/${team.club.id}`;
const chatUrl = (chatId: string) => `${base()}/chats/${chatId}`;
const reasonOf = (d: ChatDetail, personId: string) =>
  d.members.find((m) => m.personId === personId)?.reason;

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
  team = await buildTeam();
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

describe("the group's default channel", () => {
  let chatId: string;

  it("is created on first use with everyone in the group, and the children's guardians", async () => {
    const res = await api(team.coach.id, "GET", `${base()}/groups/${team.groupId}/chats`);
    expect(res.statusCode).toBe(200);
    const list = res.json<ChatList>().items;
    const channel = list.find((c) => c.defaultForGroupId === team.groupId)!;
    expect(channel).toBeDefined();
    expect(channel.name).toBe("F2015");
    expect(channel.visibility).toBe("open");
    expect(channel.hasChildren).toBe(true);
    chatId = channel.id;

    const d = (await api(team.coach.id, "GET", chatUrl(chatId))).json<ChatDetail>();
    for (const p of [team.coach, team.assistant, team.supporter]) {
      expect(reasonOf(d, p.id)).toBe("group");
    }
    expect(reasonOf(d, team.kid1.child.id)).toBe("group");
    // A leader is with the children: both children's guardians are added (ADR 0047 rule 3).
    for (const g of [team.kid1.guardian, team.kid1.coGuardian, team.kid2.guardian]) {
      expect(reasonOf(d, g.id)).toBe("guardian_auto");
    }
    const kid = d.members.find((m) => m.personId === team.kid1.child.id)!;
    expect(kid.child).toBe(true);
    const coach = d.members.find((m) => m.personId === team.coach.id)!;
    expect(coach.leader).toBe(true);
    const guardian = d.members.find((m) => m.personId === team.kid1.guardian.id)!;
    expect(guardian.guardianOf).toEqual([team.kid1.child.id]);
    expect(d.can).toMatchObject({ post: true, leave: false, manage: true });
  });

  it("shows that guardians were added, in the history everyone sees", async () => {
    const page = (
      await api(team.kid1.child.id, "GET", `${chatUrl(chatId)}/messages`)
    ).json<ChatMessagePage>();
    const system = page.items.find((m) => m.event?.type === "guardians_added");
    expect(system?.event?.personIds).toEqual(
      expect.arrayContaining([team.kid1.guardian.id, team.kid2.guardian.id]),
    );
  });

  it("cannot be left, have its members changed or be renamed: it follows the group", async () => {
    let res = await api(team.supporter.id, "POST", `${chatUrl(chatId)}/leave`);
    expect(detail(res)).toBe("chat_default_channel");
    res = await api(team.coach.id, "PATCH", chatUrl(chatId), { body: { name: "X" } });
    expect(detail(res)).toBe("chat_default_channel");
    res = await api(team.kid1.guardian.id, "POST", `${chatUrl(chatId)}/leave`);
    expect(detail(res)).toBe("chat_default_channel");
  });

  it("is not visible to a member of the club outside the group", async () => {
    const res = await api(team.outsider.id, "GET", chatUrl(chatId));
    expect(res.statusCode).toBe(404);
    const list = (
      await api(team.outsider.id, "GET", `${base()}/groups/${team.groupId}/chats`)
    ).json<ChatList>();
    expect(list.items).toEqual([]);
  });
});

describe("messages", () => {
  let chatId: string;

  beforeAll(async () => {
    const res = await api(team.coach.id, "POST", `${base()}/groups/${team.groupId}/chats`, {
      body: { name: "Coaches", visibility: "closed", memberIds: [team.assistant.id] },
    });
    expect(res.statusCode).toBe(201);
    chatId = res.json<{ id: string }>().id;
  });

  it("sends, pages and catches up", async () => {
    const sent: ChatMessage[] = [];
    for (const body of ["one", "two", "three"]) {
      const res = await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, {
        body: { body },
      });
      expect(res.statusCode).toBe(201);
      sent.push(res.json<ChatMessage>());
    }
    expect(sent[0]!.sender).toMatchObject({ kind: "person" });
    const page = (
      await api(team.assistant.id, "GET", `${chatUrl(chatId)}/messages?limit=2`)
    ).json<ChatMessagePage>();
    expect(page.items.map((m) => m.body)).toEqual(["three", "two"]);
    const older = (
      await api(team.assistant.id, "GET", `${chatUrl(chatId)}/messages?cursor=${page.nextCursor}`)
    ).json<ChatMessagePage>();
    expect(older.items.map((m) => m.body)).toContain("one");
    const after = (
      await api(team.assistant.id, "GET", `${chatUrl(chatId)}/messages?after=${sent[0]!.id}`)
    ).json<ChatMessagePage>();
    expect(after.items.map((m) => m.body)).toEqual(["two", "three"]);
  });

  it("counts unread messages and moves the read pointer forward only", async () => {
    const first = await api(team.assistant.id, "GET", "/me/chats");
    expect(first.statusCode).toBe(200);
    let mine = first.json<ChatPage>();
    let row = mine.items.find((c) => c.id === chatId)!;
    expect(row.unreadCount).toBe(3);
    expect(row.lastMessage?.excerpt).toBe("three");
    const page = (
      await api(team.assistant.id, "GET", `${chatUrl(chatId)}/messages`)
    ).json<ChatMessagePage>();
    const newest = page.items[0]!.id;
    expect(
      (
        await api(team.assistant.id, "POST", `${chatUrl(chatId)}/read`, {
          body: { messageId: newest },
        })
      ).statusCode,
    ).toBe(201);
    await api(team.assistant.id, "POST", `${chatUrl(chatId)}/read`, {
      body: { messageId: page.items[2]!.id },
    });
    mine = (await api(team.assistant.id, "GET", "/me/chats")).json<ChatPage>();
    row = mine.items.find((c) => c.id === chatId)!;
    expect(row.unreadCount).toBe(0);
    expect(row.membership?.lastReadMessageId).toBe(newest);
  });

  it("keeps every earlier text of an edited message", async () => {
    const sent = (
      await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, { body: { body: "Trainng" } })
    ).json<ChatMessage>();
    const edited = (
      await api(team.coach.id, "PATCH", `${chatUrl(chatId)}/messages/${sent.id}`, {
        body: { body: "Training" },
      })
    ).json<ChatMessage>();
    expect(edited.body).toBe("Training");
    expect(edited.editedAt).not.toBeNull();
    await api(team.coach.id, "PATCH", `${chatUrl(chatId)}/messages/${sent.id}`, {
      body: { body: "Training 18:00" },
    });
    const versions = (
      await api(team.assistant.id, "GET", `${chatUrl(chatId)}/messages/${sent.id}/versions`)
    ).json<{ items: { body: string }[] }>();
    expect(versions.items.map((v) => v.body)).toEqual(["Trainng", "Training"]);
    // Only the sender edits.
    const res = await api(team.assistant.id, "PATCH", `${chatUrl(chatId)}/messages/${sent.id}`, {
      body: { body: "mine now" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("hides a deleted message without removing it", async () => {
    const sent = (
      await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, { body: { body: "oops" } })
    ).json<ChatMessage>();
    expect(
      (await api(team.coach.id, "DELETE", `${chatUrl(chatId)}/messages/${sent.id}`)).statusCode,
    ).toBe(200);
    const page = (
      await api(team.assistant.id, "GET", `${chatUrl(chatId)}/messages?limit=1`)
    ).json<ChatMessagePage>();
    expect(page.items[0]).toMatchObject({ id: sent.id, body: "", hidden: "sender" });
    const { rows } = await t.query<{ body: string }>(
      "admin",
      "SELECT body FROM chat_messages WHERE id = $1",
      [sent.id],
    );
    expect(rows[0]?.body).toBe("oops");
  });

  it("reacts and takes it back", async () => {
    const sent = (
      await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, { body: { body: "Goal!" } })
    ).json<ChatMessage>();
    let m = (
      await api(team.assistant.id, "POST", `${chatUrl(chatId)}/messages/${sent.id}/reactions`, {
        body: { emoji: "👍", on: true },
      })
    ).json<ChatMessage>();
    expect(m.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    m = (
      await api(team.assistant.id, "POST", `${chatUrl(chatId)}/messages/${sent.id}/reactions`, {
        body: { emoji: "👍", on: false },
      })
    ).json<ChatMessage>();
    expect(m.reactions).toEqual([]);
  });

  it("accepts a resent message once (the offline queue) and refuses foreign or odd IDs", async () => {
    const id = uuidv7();
    const first = await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, {
      body: { id, body: "queued" },
    });
    const again = await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, {
      body: { id, body: "queued" },
    });
    expect(first.json<ChatMessage>().id).toBe(id);
    expect(again.json<ChatMessage>().id).toBe(id);
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM chat_messages WHERE id = $1",
      [id],
    );
    expect(rows[0]?.n).toBe(1);
    const stolen = await api(team.assistant.id, "POST", `${chatUrl(chatId)}/messages`, {
      body: { id, body: "mine" },
    });
    expect(detail(stolen)).toBe("chat_message_conflict");
    const old = await api(team.coach.id, "POST", `${chatUrl(chatId)}/messages`, {
      body: { id: "01890a5d-ac96-774b-bcce-b302099a8057", body: "from 2023" },
    });
    expect(detail(old)).toBe("invalid_input");
  });

  it("is closed to the rest of the group, and messages are for members only", async () => {
    expect((await api(team.supporter.id, "GET", chatUrl(chatId))).statusCode).toBe(404);
    expect((await api(team.supporter.id, "GET", `${chatUrl(chatId)}/messages`)).statusCode).toBe(
      404,
    );
    const list = (
      await api(team.supporter.id, "GET", `${base()}/groups/${team.groupId}/chats`)
    ).json<ChatList>();
    expect(list.items.map((c) => c.id)).not.toContain(chatId);
  });
});

describe("children's chats (ADR 0047 rules 5 and 6)", () => {
  let chatId: string;

  it("a child creates a channel with children of the group: no guardians are added", async () => {
    const res = await api(team.kid1.child.id, "POST", `${base()}/groups/${team.groupId}/chats`, {
      body: { name: "Kids", visibility: "closed", memberIds: [team.kid2.child.id] },
    });
    expect(res.statusCode).toBe(201);
    chatId = res.json<{ id: string }>().id;
    const d = (await api(team.kid1.child.id, "GET", chatUrl(chatId))).json<ChatDetail>();
    expect(d.members.map((m) => m.personId).sort()).toEqual(
      [team.kid1.child.id, team.kid2.child.id].sort(),
    );
    expect(d.chat.hasChildren).toBe(true);
  });

  it("a child cannot add an adult", async () => {
    const res = await api(team.kid1.child.id, "POST", `${base()}/groups/${team.groupId}/chats`, {
      body: { name: "With grandpa", visibility: "closed", memberIds: [team.supporter.id] },
    });
    expect(detail(res)).toBe("chat_member_not_allowed");
  });

  it("a guardian sees who is in the child's closed chat, not the messages, and may join visibly", async () => {
    await api(team.kid1.child.id, "POST", `${chatUrl(chatId)}/messages`, { body: { body: "hi" } });
    const g = team.kid1.guardian;
    const d = (await api(g.id, "GET", chatUrl(chatId))).json<ChatDetail>();
    expect(d.can.join).toBe(true);
    expect(d.can.post).toBe(false);
    const res = await api(g.id, "GET", `${chatUrl(chatId)}/messages`);
    expect(detail(res)).toBe("chat_not_a_member");
    const joined = (await api(g.id, "POST", `${chatUrl(chatId)}/join`)).json<ChatDetail>();
    expect(reasonOf(joined, g.id)).toBe("guardian_joined");
    // A parent joining adds nobody else; the whole history is readable.
    expect(joined.members).toHaveLength(3);
    const page = (await api(g.id, "GET", `${chatUrl(chatId)}/messages`)).json<ChatMessagePage>();
    expect(page.items.map((m) => m.body)).toContain("hi");
    expect(page.items.find((m) => m.event?.type === "joined")?.event?.personIds).toEqual([g.id]);
  });

  it("another child's guardian who is not in the group cannot see it", async () => {
    const other = await buildFamily(s, { club: team.club, childBirthDate: "2015-01-01" });
    expect((await api(other.guardian.id, "GET", chatUrl(chatId))).statusCode).toBe(404);
  });

  it("a leader of the group may join; the children's guardians are then added", async () => {
    const d = (await api(team.coach.id, "GET", chatUrl(chatId))).json<ChatDetail>();
    expect(d.can.join).toBe(true);
    const joined = (await api(team.coach.id, "POST", `${chatUrl(chatId)}/join`)).json<ChatDetail>();
    expect(reasonOf(joined, team.coach.id)).toBe("leader_joined");
    expect(reasonOf(joined, team.kid2.guardian.id)).toBe("guardian_auto");
    expect(reasonOf(joined, team.kid2.coGuardian.id)).toBe("guardian_auto");
    // A guardian the rule requires cannot leave or be removed.
    let res = await api(team.kid2.guardian.id, "POST", `${chatUrl(chatId)}/leave`);
    expect(detail(res)).toBe("chat_guardian_required");
    res = await api(team.coach.id, "DELETE", `${chatUrl(chatId)}/members/${team.kid2.guardian.id}`);
    expect(detail(res)).toBe("chat_guardian_required");
  });

  it("when the leader leaves, the guardians the rule added leave too", async () => {
    expect((await api(team.coach.id, "POST", `${chatUrl(chatId)}/leave`)).statusCode).toBe(201);
    const d = (await api(team.kid1.child.id, "GET", chatUrl(chatId))).json<ChatDetail>();
    expect(reasonOf(d, team.kid2.guardian.id)).toBeUndefined();
    // The guardian who joined by choice stays.
    expect(reasonOf(d, team.kid1.guardian.id)).toBe("guardian_joined");
  });

  it("a guardian acting on behalf of the child never reads the child's chats", async () => {
    const g = team.kid1.guardian;
    const mine = (
      await api(g.id, "GET", "/me/chats", { onBehalfOf: team.kid1.child.id })
    ).json<ChatPage>();
    expect(mine.items).toEqual([]);
    const res = await api(g.id, "GET", chatUrl(chatId), { onBehalfOf: team.kid1.child.id });
    expect(res.statusCode).toBe(404);
  });
});

describe("direct messages (ADR 0047 rules 3 and 4)", () => {
  it("a leader writes to a child: the child's guardians are added", async () => {
    const res = await api(team.coach.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.kid1.child.id },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ id: string }>().id;
    const d = (await api(team.coach.id, "GET", chatUrl(id))).json<ChatDetail>();
    expect(reasonOf(d, team.kid1.guardian.id)).toBe("guardian_auto");
    expect(reasonOf(d, team.kid1.coGuardian.id)).toBe("guardian_auto");
    expect(d.chat.kind).toBe("direct");
    // The same conversation again.
    const again = await api(team.coach.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.kid1.child.id },
    });
    expect(again.json<{ id: string }>().id).toBe(id);
  });

  it("another adult cannot write to someone else's child", async () => {
    for (const adult of [team.supporter, team.kid2.guardian, team.outsider]) {
      const res = await api(adult.id, "POST", `${base()}/direct-chats`, {
        body: { personId: team.kid1.child.id },
      });
      expect(detail(res)).toBe("chat_child_protected");
    }
  });

  it("children of a group write to each other; a guardian writes to their child", async () => {
    let res = await api(team.kid1.child.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.kid2.child.id },
    });
    expect(res.statusCode).toBe(201);
    const d = (
      await api(team.kid1.child.id, "GET", chatUrl(res.json<{ id: string }>().id))
    ).json<ChatDetail>();
    expect(d.members).toHaveLength(2);
    res = await api(team.kid1.guardian.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.kid1.child.id },
    });
    expect(res.statusCode).toBe(201);
  });

  it("adults write to adults; nobody writes to themselves", async () => {
    let res = await api(team.supporter.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.outsider.id },
    });
    expect(res.statusCode).toBe(201);
    res = await api(team.supporter.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.supporter.id },
    });
    expect(detail(res)).toBe("chat_self");
  });
});

describe("protected identity (ADR 0022)", () => {
  it("a protected person is offered a channel, not added, and may decline for good", async () => {
    const prot = await buildPerson(s);
    await s.memberships.addMember(team.club.ctx, prot.id);
    await s.memberships.addToGroup(team.club.ctx, team.groupId, prot.id, "member");
    await t.query("admin", "UPDATE people SET protected_identity = true WHERE id = $1", [prot.id]);
    const res = await api(team.coach.id, "POST", `${base()}/groups/${team.groupId}/chats`, {
      body: { name: "Match", visibility: "closed", memberIds: [prot.id] },
    });
    const id = res.json<{ id: string }>().id;
    const seen = (await api(team.coach.id, "GET", chatUrl(id))).json<ChatDetail>();
    expect(seen.members.find((m) => m.personId === prot.id)?.status).toBe("offered");
    // Offered: sees the chat, cannot read or write until accepting.
    const own = (await api(prot.id, "GET", chatUrl(id))).json<ChatDetail>();
    expect(own.can).toMatchObject({ join: true, post: false });
    expect(detail(await api(prot.id, "GET", `${chatUrl(id)}/messages`))).toBe("chat_not_a_member");
    expect((await api(prot.id, "POST", `${chatUrl(id)}/leave`)).statusCode).toBe(201);
    // Declining is final for the group's channel too: the sync does not offer it again.
    const { rows } = await t.query<{ status: string }>(
      "admin",
      "SELECT status FROM chat_members WHERE chat_id = $1 AND person_id = $2",
      [id, prot.id],
    );
    expect(rows[0]?.status).toBe("left");
  });
});

describe("tenant isolation and erasure", () => {
  it("a user of another club gets 404", async () => {
    const other = await buildClub(s);
    const list = (
      await api(team.coach.id, "GET", `${base()}/groups/${team.groupId}/chats`)
    ).json<ChatList>();
    const id = list.items[0]!.id;
    expect((await api(other.manager.id, "GET", chatUrl(id))).statusCode).toBe(404);
    expect((await api(other.manager.id, "GET", `/clubs/${other.id}/chats/${id}`)).statusCode).toBe(
      404,
    );
  });

  it("erasure takes the person out of every chat; their messages stay as a former member's", async () => {
    const leaver = await buildPerson(s);
    await s.memberships.addMember(team.club.ctx, leaver.id);
    const res = await api(leaver.id, "POST", `${base()}/direct-chats`, {
      body: { personId: team.supporter.id },
    });
    const id = res.json<{ id: string }>().id;
    await api(leaver.id, "POST", `${chatUrl(id)}/messages`, { body: { body: "bye" } });
    await t.query("retention", "SELECT privacy.erase_person($1, 'test')", [leaver.id]);
    const page = (
      await api(team.supporter.id, "GET", `${chatUrl(id)}/messages`)
    ).json<ChatMessagePage>();
    const bye = page.items.find((m) => m.body === "bye")!;
    expect(bye.sender).toEqual({ kind: "former_member" });
    const { rows } = await t.query<{ status: string }>(
      "admin",
      "SELECT status FROM chat_members WHERE chat_id = $1 AND person_id = $2",
      [id, leaver.id],
    );
    expect(rows[0]?.status).toBe("left");
  });
});

describe("the real-time connection", () => {
  let url: string;

  beforeAll(async () => {
    await app.app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.app.getHttpServer().address() as { port: number };
    url = `ws://127.0.0.1:${address.port}/api/v1/realtime`;
  });

  async function connect(personId: string): Promise<{ ws: WebSocket; events: unknown[] }> {
    const ticket = (await api(personId, "POST", "/realtime/tickets")).json<RealtimeTicket>();
    expect(new URL(ticket.url).pathname).toBe("/api/v1/realtime");
    const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket.ticket)}`);
    const events: unknown[] = [];
    ws.on("message", (data: Buffer) => events.push(JSON.parse(data.toString("utf8"))));
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      const check = () =>
        events.some((e) => (e as { type: string }).type === "ready")
          ? resolve()
          : setTimeout(check, 10);
      check();
    });
    return { ws, events };
  }
  const waitFor = async (events: unknown[], match: (e: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = events.find((e) => match(e as Record<string, unknown>));
      if (found) return found as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("event did not arrive");
  };

  it("refuses a connection without a valid ticket, and a ticket used twice", async () => {
    const bad = new WebSocket(`${url}?ticket=${"x".repeat(43)}`);
    const status = await new Promise<number>((resolve) => {
      bad.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      bad.on("error", () => undefined);
    });
    expect(status).toBe(401);
    const ticket = (await api(team.coach.id, "POST", "/realtime/tickets")).json<RealtimeTicket>();
    const first = new WebSocket(`${url}?ticket=${ticket.ticket}`);
    await new Promise((r) => first.once("open", r));
    const second = new WebSocket(`${url}?ticket=${ticket.ticket}`);
    const again = await new Promise<number>((resolve) => {
      second.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      second.on("error", () => undefined);
    });
    expect(again).toBe(401);
    first.close();
  });

  it("delivers new messages (IDs only) and typing to the chat's members", async () => {
    const created = (
      await api(team.coach.id, "POST", `${base()}/groups/${team.groupId}/chats`, {
        body: { name: "Live", visibility: "closed", memberIds: [team.assistant.id] },
      })
    ).json<{ id: string }>();
    const assistant = await connect(team.assistant.id);
    const supporter = await connect(team.supporter.id);
    const coach = await connect(team.coach.id);
    const sent = (
      await api(team.coach.id, "POST", `${chatUrl(created.id)}/messages`, {
        body: { body: "secret plan" },
      })
    ).json<ChatMessage>();
    const event = await waitFor(assistant.events, (e) => e.type === "message.created");
    expect(event).toEqual({
      type: "message.created",
      clubId: team.club.id,
      chatId: created.id,
      messageId: sent.id,
    });
    expect(JSON.stringify(assistant.events)).not.toContain("secret plan");
    coach.ws.send(JSON.stringify({ type: "typing", chatId: created.id }));
    await waitFor(assistant.events, (e) => e.type === "typing" && e.personId === team.coach.id);
    // Not a member: nothing.
    await new Promise((r) => setTimeout(r, 100));
    expect(supporter.events.some((e) => (e as { type: string }).type === "message.created")).toBe(
      false,
    );
    // Added later: the connection starts listening to the chat.
    await api(team.coach.id, "POST", `${chatUrl(created.id)}/members`, {
      body: { personIds: [team.supporter.id] },
    });
    await waitFor(supporter.events, (e) => e.type === "chats.changed");
    await new Promise((r) => setTimeout(r, 50));
    await api(team.coach.id, "POST", `${chatUrl(created.id)}/messages`, {
      body: { body: "welcome" },
    });
    await waitFor(supporter.events, (e) => e.type === "message.created");
    for (const c of [assistant, supporter, coach]) c.ws.close();
  });
});
