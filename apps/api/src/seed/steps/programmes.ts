// SPDX-License-Identifier: AGPL-3.0-only
// Programmes and templates (P2.9, docs/seed-data.md):
// - SVK F2017's "Höstcupen i Strandviken" (the P1.6 event) is a programme:
//   its matches in Strandvikshallen A and B, the lunch, kiosk and
//   score-table shifts at every match. Erik saved it as the template
//   "Höstcupen", and last year's edition was laid out from it.
// - IK Norrbacka P2012's group template "Hemmamatchdag" from P2.6's home
//   match (the match, the kiosk with two places, the score table).
// - IK Norrbacka's club template "Städdag": a morning with two work shifts
//   and coffee, for every team.
// Written through the services as the personas would (no people copied).

import { sql, type TenantContext } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";
import { DEMO_DUTY_IDS } from "./duties.ts";

const DAY_MS = 86_400_000;

export const programmesDemoStep: DemoStep = {
  name: "programmes",
  async run(env, _data, core) {
    const s = env.services;
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`programmes seed: unknown key ${key}`);
      return found;
    };
    const as = (persona: string, club: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId: id(club),
      requestId: "seed:programmes",
    });
    const anna = as("anna", "svk");
    const erik = as("erik", "svk");
    const f2017 = id("svk-f2017");

    // --- Höstcupen i Strandviken (SVK F2017) ----------------------------------------
    const hallA = await s.activities.createLocation(anna, {
      name: "Strandvikshallen A",
      street: "Hamnvägen 2",
      city: "Strandviken",
    });
    const hallB = await s.activities.createLocation(anna, {
      name: "Strandvikshallen B",
      street: "Hamnvägen 2",
      city: "Strandviken",
      directions: "Ingång från parkeringen, hall B till vänster.",
    });
    const { cupId, sessions } = await env.db.withTenant(anna, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM public.events WHERE title = 'Höstcupen i Strandviken'`);
      const cup = rows[0]!.id;
      const { rows: acts } = await tx.execute<{ id: string; kind: string; title: string }>(sql`
        SELECT a.id, a.kind, a.title FROM public.event_activities ea
        JOIN public.activities a ON a.id = ea.activity_id
        WHERE ea.event_id = ${cup}::uuid ORDER BY a.starts_at`);
      return { cupId: cup, sessions: acts };
    });
    const { types } = await s.duties.listTypes(anna, false);
    const kiosk = types.find((t) => t.name === "Kiosk")!;
    const scoreTable = types.find((t) => t.name === "Sekretariat")!;
    let hall = 0;
    for (const session of sessions) {
      if (session.kind !== "match") continue;
      const locationId = hall++ % 2 === 0 ? hallA.id : hallB.id;
      const updated = await s.activities.updateActivity(erik, session.id, { locationId });
      const times = {
        startsAt: updated.activity.startsAt.toISOString(),
        endsAt: updated.activity.endsAt.toISOString(),
      };
      await s.duties.createShift(
        anna,
        { groupId: f2017 },
        {
          dutyTypeId: kiosk.id,
          title: `Kiosk – ${session.title}`,
          ...times,
          locationId,
          needed: 2,
          activityId: session.id,
        },
      );
      await s.duties.createShift(
        anna,
        { groupId: f2017 },
        {
          dutyTypeId: scoreTable.id,
          title: `Sekretariat – ${session.title}`,
          ...times,
          locationId,
          needed: 1,
          activityId: session.id,
        },
      );
    }
    const cupProgramme = await s.programmes.ensureEventProgramme(erik, cupId);
    const template = await s.programmes.createTemplate(erik, {
      name: "Höstcupen",
      description: "Cupen i Strandvikshallen: matcher, lunch, kiosk och sekretariat.",
      groupId: f2017,
      source: { programmeId: cupProgramme.programme.id },
    });
    // Last year's edition, 52 weeks earlier (the same weekday).
    const lastYear = new Date(
      Date.parse(`${cupProgramme.programme.firstDay}T00:00:00Z`) - 364 * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    const edition = await s.programmes.apply(
      erik,
      { templateId: template.id },
      {
        firstDay: lastYear,
        edition: lastYear.slice(0, 4),
        title: `Höstcupen ${lastYear.slice(0, 4)}`,
      },
    );
    // Its event (a draft, as laid out) carries the year: this year's is the one people find.
    if (edition.programme.eventId) {
      await s.events.updateEvent(erik, edition.programme.eventId, {
        title: `Höstcupen i Strandviken ${lastYear.slice(0, 4)}`,
      });
    }

    // --- IK Norrbacka -----------------------------------------------------------------
    await s.programmes.createTemplate(as("ahmed", "ikn"), {
      name: "Hemmamatchdag",
      description: "Hemmamatch med kiosk (två platser) och sekretariat.",
      groupId: id("ikn-p2012"),
      source: { activityId: DEMO_DUTY_IDS.homeMatch },
    });
    const karin = as("karin", "ikn");
    const cleaning = await s.duties.createType(karin, {
      name: "Städpass",
      instruction: "Ta med arbetshandskar. Redskap finns i förrådet vid klubbstugan.",
      childContact: "none",
    });
    const staddag = await s.programmes.createTemplate(karin, {
      name: "Städdag",
      description: "En förmiddag med två arbetspass och fika, för varje lag.",
      groupId: null,
      source: { empty: true },
    });
    const item = {
      parentRef: null,
      dayOffset: 0,
      endDayOffset: 0,
      slotKeys: ["lag"],
      kindLabel: null,
      notes: null,
      locationId: null,
      locationText: "Norrbacka IP",
      meetMinutesBefore: null,
      meetPlace: null,
      transportMode: null,
      homeAway: null,
      opponent: null,
      responseMode: "none" as const,
      dutyTypeId: null,
      needed: null,
    };
    await s.programmes.updateTemplate(karin, staddag.id, {
      dayCount: 1,
      slots: [{ key: "lag", label: "Laget", defaultGroupId: null }],
      items: [
        {
          ...item,
          ref: "stad",
          kind: "activity",
          activityKind: "other",
          kindLabel: "Städdag",
          title: "Städdag",
          startTime: "09:00",
          endTime: "12:00",
          responseMode: "optional",
        },
        {
          ...item,
          ref: "fika",
          kind: "activity",
          activityKind: "other",
          kindLabel: "Fika",
          title: "Fika",
          startTime: "10:30",
          endTime: "11:00",
        },
        {
          ...item,
          ref: "pass1",
          kind: "duty_shift",
          parentRef: "stad",
          activityKind: null,
          responseMode: null,
          locationText: null,
          title: "Städpass – första",
          startTime: "09:00",
          endTime: "10:30",
          dutyTypeId: cleaning.id,
          needed: 4,
        },
        {
          ...item,
          ref: "pass2",
          kind: "duty_shift",
          parentRef: "stad",
          activityKind: null,
          responseMode: null,
          locationText: null,
          title: "Städpass – andra",
          startTime: "10:30",
          endTime: "12:00",
          dutyTypeId: cleaning.id,
          needed: 4,
        },
      ],
    });

    // The events are history, not news (as the other steps').
    await env.db.withSystem("seed:programmes", {}, (tx) =>
      tx.execute(sql`
        INSERT INTO outbox.deliveries (event_id, handler)
        SELECT e.id, 'notifications' FROM outbox.events e WHERE e.status <> 'done'
        ON CONFLICT DO NOTHING`),
    );
  },
};
