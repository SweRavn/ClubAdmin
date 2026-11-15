// SPDX-License-Identifier: AGPL-3.0-only
// Demo governing documents and meetings (P2.4, ADR 0049, docs/seed-data.md),
// in IK Norrbacka, written by Karin (the secretary):
// - the statutes, adopted at last year's annual meeting, with the
//   retention of former members marked as a setting (decided and applied);
// - a board meeting of Styrelsen last week from the country pack's
//   template: minutes per item, a decision on the budget and an action item
//   for Peter (in his "Mina uppgifter");
// - its minutes assembled into the board's minutes, signed by Göran as
//   chair and waiting for Peter as adjuster ("Väntar på min signatur").
// Written through the services as the personas; their events are history
// (no notices are sent when the worker starts).

import { getCountryPack } from "@clubadmin/country-packs";
import { sql, type TenantContext } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

export const governingDemoStep: DemoStep = {
  name: "governing",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`governing seed: unknown key ${key}`);
      return found;
    };
    const s = env.services;
    const clubId = id("ikn");
    const boardId = id("ikn-styrelsen");
    const as = (persona: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId,
      requestId: "seed:governing",
    });
    const karin = as("karin");
    const day = 86_400_000;
    const now = env.clock.now.getTime();
    const date = (offset: number) => new Date(now + offset * day).toISOString().slice(0, 10);

    // The statutes, adopted at last year's annual meeting.
    const statutesSeries = await s.governing.createSeries(karin, {
      name: "Stadgar",
      seriesKind: "statutes",
    });
    const statutes = await s.governing.create(karin, {
      seriesId: statutesSeries,
      name: "Stadgar för IK Norrbacka",
      body: [
        "# Stadgar för IK Norrbacka",
        "",
        "## § 1 Ändamål",
        "Föreningen ska bedriva idrott för barn, ungdomar och vuxna i Norrbacka.",
        "",
        "## § 5 Medlemskap",
        "Medlem är den som har betalat årets medlemsavgift.",
        "",
        "## § 12 Uppgifter om medlemmar",
        "Uppgifter om den som har lämnat föreningen sparas i {{setting former_member_retention_months = 24}} månader.",
      ].join("\n"),
    });
    await s.governing.adopt(karin, statutes.id, {
      versionId: statutes.versionId,
      adoptedOn: date(-250),
      decisionBody: "annual_meeting",
      reference: "Årsmötet, § 14",
    });

    // The board's minutes and last week's board meeting from the template.
    const minutesSeries = await s.governing.createSeries(karin, {
      name: "Styrelseprotokoll",
      seriesKind: "board_minutes",
      groupId: boardId,
    });
    const meeting = await s.activities.createActivity(karin, boardId, {
      kind: "meeting",
      title: "Styrelsemöte",
      startsAt: `${date(-7)}T17:00:00Z`,
      endsAt: `${date(-7)}T19:00:00Z`,
    });
    const meetingKey = { kind: "activity" as const, id: meeting.activity.id };
    const template = getCountryPack("SE").agendaTemplates!.find(
      (x) => x.key === "se.board_meeting",
    )!;
    const minutes: Record<string, string> = {
      "Mötets öppnande": "Karin öppnade mötet.",
      Ekonomi: "Peter redogjorde för budgeten inför våren. Kostnaden för domare har ökat.",
      "Övriga frågor": "Städdagen flyttas till den 25 april.",
    };
    await s.meetings.putAgenda(karin, meetingKey, {
      items: template.items.map((item) => ({
        title: item.title,
        minutes: minutes[item.title] ?? null,
        ...(item.title === "Ekonomi"
          ? {
              presenterPersonId: id("peter"),
              decisions: ["Styrelsen fastställer budgeten för våren."],
              actions: [
                {
                  title: "Skicka budgeten till revisorerna",
                  dueDate: date(14),
                  assignees: [{ personId: id("peter") }],
                },
              ],
            }
          : {}),
      })),
    });
    const assembled = await s.meetings.assembleMinutes(karin, meetingKey, {
      seriesId: minutesSeries,
    });
    await s.governing.putSigners(karin, assembled.documentId, assembled.versionId, {
      signers: [
        { personId: id("goran"), role: "chair" },
        { personId: id("peter"), role: "adjuster" },
      ],
    });
    await s.governing.sign(as("goran"), assembled.documentId, assembled.versionId);

    // The events are history, not news (as the chat and announcements steps').
    await env.db.withSystem("seed:governing", {}, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox.deliveries (event_id, handler)
        SELECT e.id, 'notifications' FROM outbox.events e WHERE e.status <> 'done'
        ON CONFLICT DO NOTHING`),
    );
  },
};
