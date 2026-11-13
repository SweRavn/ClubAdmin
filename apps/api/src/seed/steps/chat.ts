// SPDX-License-Identifier: AGPL-3.0-only
// Demo chats (P2.1, ADR 0047, docs/seed-data.md), written through the chat
// service as the personas, so the rules apply as in the app:
// - every group's default channel (everyone in it; the children's
//   guardians where a leader is with children);
// - SVK F2017: a conversation in the team channel (an edit, a reaction, a
//   reply), the closed "Ledare" channel of Erik, Johan and Sara, the
//   children's chat "Tjejerna" of Elsa, Alva and Maja that Anna joined, and
//   Johan's direct message to Alva (her guardians were added);
// - IKN F2015: Erik's closed "Föräldrar" channel offered to Samira
//   (protected identity, ADR 0022), who accepted it.

import type { TenantContext } from "@clubadmin/db";
import { sql } from "@clubadmin/db";

import type { ChatResource } from "../../modules/authorization/index.ts";
import type { DemoStep } from "../environment.ts";

export const chatDemoStep: DemoStep = {
  name: "chat",
  async run(env, data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`chat seed: unknown key ${key}`);
      return found;
    };
    const chat = env.services.chat;
    const as = (persona: string, club: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId: id(club),
      requestId: "seed:chat",
    });
    /** The chat as the service needs it (the seed acts as members, the policies are the API's). */
    const resource = (club: string, chatId: string, groups: string[] = []): ChatResource => ({
      kind: "chat",
      clubId: id(club),
      chatId,
      chatKind: "channel",
      visibility: "closed",
      archived: false,
      createdByPersonId: null,
      defaultForGroupId: null,
      groups: groups.map((g) => ({ clubId: id(club), groupId: id(g), ancestorIds: [] })),
      membership: "active",
      wardMembers: [],
      hasChildren: false,
    });

    // Every group's default channel.
    for (const club of data.clubs) {
      const clubId = id(club.key);
      await env.db.withSystem("seed:chat", { clubId }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM public.groups WHERE club_id = ${clubId} AND archived_at IS NULL ORDER BY id`);
        for (const g of rows) await tx.execute(sql`SELECT app.chat_sync_group(${g.id}::uuid)`);
      });
    }
    const defaultChannel = async (club: string, group: string) => {
      const { rows } = await env.db.withSystem("seed:chat", { clubId: id(club) }, (tx) =>
        tx.execute<{ id: string }>(
          sql`SELECT id FROM public.chats WHERE default_for_group_id = ${id(group)}`,
        ),
      );
      return rows[0]!.id;
    };

    // SVK F2017's team channel: Erik moves a training, Anna answers, a reaction and an edit.
    const team = await defaultChannel("svk", "svk-f2017");
    const moved = await chat.send(as("erik", "svk"), resource("svk", team), {
      body: "Hej alla! Torsdagens träning flyttas till kl. 18:00 i Strandvikshallen.",
    });
    await chat.edit(
      as("erik", "svk"),
      resource("svk", team),
      moved.id,
      "Hej alla! Torsdagens träning flyttas till kl. 18:30 i Strandvikshallen.",
    );
    const answer = await chat.send(as("anna", "svk"), resource("svk", team), {
      body: "Tack! Elsa kommer, men vi blir lite sena.",
      replyToId: moved.id,
    });
    await chat.react(as("sara", "svk"), resource("svk", team), moved.id, "👍", true);
    await chat.react(as("johan", "svk"), resource("svk", team), moved.id, "👍", true);
    await chat.send(as("sara", "svk"), resource("svk", team), {
      body: "Påminnelse: kiosken på lördag behöver två vuxna till.",
    });
    await chat.markRead(as("erik", "svk"), resource("svk", team), answer.id);

    // The leaders' closed channel.
    const leaders = await chat.createChannel(as("erik", "svk"), {
      name: "Ledare",
      description: "Tränare och lagledare i F2017",
      visibility: "closed",
      memberIds: [id("johan"), id("sara")],
      everyone: false,
      groupId: id("svk-f2017"),
    });
    await chat.send(as("erik", "svk"), resource("svk", leaders), {
      body: "Laguttagning till cupen: jag skickar förslag i kväll.",
    });
    await chat.send(as("johan", "svk"), resource("svk", leaders), {
      body: "Bra, jag kan inte vara med på söndag.",
    });

    // The children's chat: Maja creates it with Elsa and Alva; Anna (Elsa's mother) joined, visibly.
    const kids = await chat.createChannel(as("maja", "svk"), {
      name: "Tjejerna",
      visibility: "closed",
      memberIds: [id("elsa"), id("alva")],
      everyone: false,
      groupId: id("svk-f2017"),
    });
    await chat.send(as("maja", "svk"), resource("svk", kids), {
      body: "Ska vi ha samma tröjor på cupen?",
    });
    await chat.send(as("alva", "svk"), resource("svk", kids), { body: "Jaaa! 💜" });
    await chat.join(as("anna", "svk"), { ...resource("svk", kids), membership: null }, "guardian");

    // Johan writes to Alva directly: her guardians (Sara) are added (ADR 0047 rule 3).
    const direct = await chat.openDirect(as("johan", "svk"), id("alva"));
    await chat.send(
      as("johan", "svk"),
      { ...resource("svk", direct), chatKind: "direct" },
      {
        body: "Hej Alva! Kan du ta med bollnätet på torsdag?",
      },
    );

    // IKN F2015: Erik's parents' channel, offered to Samira (protected), who accepted it.
    const parents = await chat.createChannel(as("erik", "ikn"), {
      name: "Föräldrar",
      description: "Samåkning, kiosk och annat praktiskt",
      visibility: "closed",
      memberIds: [id("samira")],
      everyone: false,
      groupId: id("ikn-f2015"),
    });
    await chat.join(
      as("samira", "ikn"),
      { ...resource("ikn", parents), membership: "offered" },
      "self",
    );
    await chat.send(as("erik", "ikn"), resource("ikn", parents), {
      body: "Vem kan köra till bortamatchen i Gränby på söndag?",
    });
  },
};
