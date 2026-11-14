// SPDX-License-Identifier: AGPL-3.0-only
// Demo announcements (P2.3, ADR 0053, docs/seed-data.md), in IK Norrbacka:
// - Göran (club manager) called the whole club to the annual meeting: an
//   important announcement on every channel, pinned for a month;
// - Erik (F2015's assistant coach) told the team the pitch is closed this
//   week (board and push);
// - Göran's newsletter is scheduled for next week (not sent yet).
// Anna (Oskar's parent) has read the team's and not the meeting's: one unread.
// Written through the announcements service as the personas; their events
// are history (no notices are sent when the worker starts).

import { sql, type TenantContext } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

export const announcementsDemoStep: DemoStep = {
  name: "announcements",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`announcements seed: unknown key ${key}`);
      return found;
    };
    const s = env.services;
    const clubId = id("ikn");
    const as = (persona: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId,
      requestId: "seed:announcements",
    });
    const day = 86_400_000;
    const now = env.clock.now.getTime();

    await s.announcements.create(
      as("goran"),
      { groupId: null },
      {
        title: "Kallelse till årsmöte 12 mars",
        body: [
          "Välkomna till **IK Norrbackas årsmöte** den 12 mars kl. 18.30 i klubbstugan.",
          "",
          "- Verksamhetsberättelse och bokslut",
          "- Val av styrelse",
          "- Motioner (skicka dem senast 15 februari)",
          "",
          "Handlingarna finns under Dokument. Vi bjuder på kaffe!",
        ].join("\n"),
        channels: ["board", "push", "email"],
        important: true,
        pinnedUntil: new Date(now + 30 * day).toISOString(),
        send: true,
      },
    );
    const pitch = await s.announcements.create(
      as("erik"),
      { groupId: id("ikn-f2015") },
      {
        title: "Planen är stängd den här veckan",
        body: "Konstgräset byts, så vi tränar **inte** tisdag och torsdag. Vi ses på lördag!",
        channels: ["board", "push"],
        important: false,
        send: true,
      },
    );
    await s.announcements.create(
      as("goran"),
      { groupId: null },
      {
        title: "Nyhetsbrev: våren i IK Norrbacka",
        body: "Sommarlägret, nya tränare och städdagen. Mer om allt i brevet.",
        channels: ["board", "email"],
        important: false,
        scheduledAt: new Date(now + 7 * day).toISOString(),
        send: true,
      },
    );
    await s.announcements.markRead(as("anna"), pitch);

    // The announcements' events are history, not news (as the chat step's).
    await env.db.withSystem("seed:announcements", {}, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox.deliveries (event_id, handler)
        SELECT e.id, 'notifications' FROM outbox.events e WHERE e.status <> 'done'
        ON CONFLICT DO NOTHING`),
    );
  },
};
