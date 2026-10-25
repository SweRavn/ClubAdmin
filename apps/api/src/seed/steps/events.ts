// SPDX-License-Identifier: AGPL-3.0-only
// Demo events (P1.6, ADR 0038; docs/seed-data.md), through the events
// service with the persona as actor: Erik's "Höstcupen i Strandviken" for
// SVK F2017 (six places, offers on the waiting list, a form with a T-shirt
// size, allergies as a sensitive question and "can drive", two matches
// created with it), full with four waiting; one player cancelled
// yesterday, so the first in the queue had an offer that has run out (the
// API's job expires it and offers the place to the next). Karin's
// "Avslutningsfest" for all of IKN (places move up automatically), with
// Samira's sign-up of Nadia.

import type { TenantContext } from "@clubadmin/db";

import { EventsService } from "../../modules/events/index.ts";
import type { DemoStep } from "../environment.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const eventsDemoStep: DemoStep = {
  name: "events",
  async run(env, _data, core) {
    const s = env.services;
    const id = (key: string) => {
      const value = core.ids.get(key);
      if (!value) throw new Error(`no id for ${key}`);
      return value;
    };
    const as = (person: string, club: string, at?: Date): TenantContext => ({
      actorKind: "person",
      personId: id(person),
      clubId: id(club),
      requestId: "seed:demo",
      ...(at ? { seedTime: at } : {}),
    });
    const now = env.clock.now;
    const day = (offset: number, hour: number) =>
      new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, hour),
      ).toISOString();
    /** The service as it was at a time (deadlines and offers are checked against it). */
    const at = (time: Date) =>
      new EventsService(
        env.db,
        {
          clubs: s.clubs,
          activities: s.activities,
          attendance: s.attendance,
          encryption: s.encryption,
        },
        () => time,
      );
    const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
    const yesterday = new Date(now.getTime() - 30 * HOUR_MS);

    // --- Höstcupen i Strandviken (SVK F2017) ----------------------------------------------
    const cup = await at(threeDaysAgo).createEvent(as("erik", "svk", threeDaysAgo), {
      title: "Höstcupen i Strandviken",
      description: "Två matcher på lördagen. Samling vid Strandvikshallen 08.30.",
      audience: "groups",
      groupIds: [id("svk-f2017")],
      startsAt: day(12, 7),
      endsAt: day(12, 14),
      locationText: "Strandvikshallen",
      priceText: "150 kr per spelare",
      registrationClosesAt: day(8, 20),
      capacity: 6,
      waitlistMode: "offer",
      offerReplyHours: 24,
      questions: [
        {
          id: "tshirt",
          type: "choice",
          label: "T-shirtstorlek",
          required: true,
          options: ["XS", "S", "M"],
        },
        { id: "allergies", type: "long_text", label: "Allergier eller mediciner", sensitive: true },
        { id: "drive", type: "yes_no", label: "Kan en vuxen köra till cupen?" },
      ],
      activities: [
        { kind: "match", title: "Höstcupen: gruppspel", startsAt: day(12, 7), endsAt: day(12, 9) },
        { kind: "match", title: "Höstcupen: slutspel", startsAt: day(12, 11), endsAt: day(12, 13) },
      ],
      publish: true,
    });
    const cupId = cup.event.id;
    const early = at(threeDaysAgo);
    await early.register(as("sara", "svk", threeDaysAgo), cupId, id("alva"), {
      answers: { tshirt: "S", allergies: "Nötter (har adrenalinpenna)", drive: true },
    });
    await early.register(as("erik", "svk", threeDaysAgo), cupId, id("maja"), {
      answers: { tshirt: "S", drive: false },
    });
    // Generated players (no guardians in the seed) sign up themselves.
    const players = (core.generated.get("svk-f2017") ?? []).slice(0, 10);
    for (const [i, child] of players.entries()) {
      await early.register({ ...as("anna", "svk", threeDaysAgo), personId: child }, cupId, child, {
        answers: { tshirt: (["XS", "S", "M"] as const)[i % 3]! },
      });
    }
    // Elsa signed up last (Anna): on the waiting list.
    await early.register(as("anna", "svk", threeDaysAgo), cupId, id("elsa"), {
      answers: { tshirt: "M", drive: true },
    });
    // A player cancelled 30 hours ago: the first in the queue got an offer for 24 hours.
    if (players[0]) {
      await at(yesterday).cancelRegistration(
        { ...as("anna", "svk", yesterday), personId: players[0] },
        cupId,
        players[0],
      );
    }

    // --- Avslutningsfest (all of IKN) ---------------------------------------------------
    const party = await s.events.createEvent(as("karin", "ikn"), {
      title: "Avslutningsfest",
      description: "Grillning och prisutdelning för hela föreningen.",
      audience: "club",
      startsAt: day(20, 15),
      endsAt: day(20, 19),
      locationText: "Klubbstugan",
      registrationClosesAt: day(16, 20),
      capacity: 80,
      questions: [
        {
          id: "food",
          type: "choices",
          label: "Matpreferenser",
          options: ["Vegetariskt", "Glutenfritt", "Laktosfritt"],
        },
        { id: "guests", type: "number", label: "Antal medföljande vuxna" },
      ],
      publish: true,
    });
    await s.events.register(as("samira", "ikn"), party.event.id, id("nadia"), {
      answers: { food: ["Vegetariskt"], guests: 1 },
    });
  },
};
