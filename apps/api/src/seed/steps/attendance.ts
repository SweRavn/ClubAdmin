// SPDX-License-Identifier: AGPL-3.0-only
// Demo responses and attendance (P1.5, docs/seed-data.md "activity and
// other data"), through the attendance service with the persona as actor:
// answers for the coming two weeks in SVK F2017 and IKN, Oskar's and Liam's
// own answers to the P2012 match (with a deadline the day before; a call-up
// of Oskar and half the team, #19), Elsa's
// answer changed by her father, attendance for the youth teams' past
// sessions (taken by their leaders on the day; one short session and one
// with two participants, below the LOK-stöd thresholds), a guest from
// Minivolley, and Sara's correction of Alva's mark 40 days ago.

import type { TenantContext } from "@clubadmin/db";
import type { AttendanceStatus } from "@clubadmin/shared";

import { AttendanceService } from "../../modules/activities/index.ts";
import type { DemoStep } from "../environment.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The youth teams whose past sessions get attendance, with who takes it. */
const TEAMS = [
  { group: "svk-f2017", club: "svk", leader: "erik" },
  { group: "ikn-p2012", club: "ikn", leader: "ahmed" },
  { group: "ikn-f2015", club: "ikn", leader: "erik" },
  { group: "fil-j2014", club: "fil", leader: "lars" },
] as const;

/** Who reads each club's calendars in the seed (its manager). */
const MANAGERS: Record<string, string> = { svk: "anna", ikn: "karin", fil: "lars" };

export const attendanceDemoStep: DemoStep = {
  name: "attendance",
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
    /** The service as it was at a time (the lock and deadlines are checked against it). */
    const at = (time: Date) =>
      new AttendanceService(
        env.db,
        { clubs: s.clubs, people: s.people, memberships: s.memberships },
        () => time,
      );
    const calendar = async (club: string, group: string, from: number, to: number) =>
      (
        await s.activities.groupCalendar(as(MANAGERS[club]!, club), id(group), {
          from: new Date(now.getTime() + from).toISOString(),
          to: new Date(now.getTime() + to).toISOString(),
          limit: 500,
        })
      ).items.map((v) => v.activity);

    // --- Answers for the coming two weeks ----------------------------------------------
    const coming = (club: string, group: string) =>
      calendar(club, group, 0, 14 * DAY_MS).then((list) =>
        list.filter((a) => a.status === "scheduled" && a.responseMode !== "none"),
      );
    const f2017 = await coming("svk", "svk-f2017");
    const generatedF2017 = core.generated.get("svk-f2017") ?? [];
    for (const [i, activity] of f2017.entries()) {
      await s.attendance.respond(as("sara", "svk"), activity.id, id("alva"), {
        status: "attending",
      });
      await s.attendance.respond(as("erik", "svk"), activity.id, id("maja"), {
        status: i % 3 === 2 ? "not_attending" : "attending",
      });
      // About half of the generated players answered (themselves, as the seed has no guardians for them).
      for (const [j, child] of generatedF2017.entries()) {
        if ((i + j) % 2 === 1) continue;
        await s.attendance.respond({ ...as("anna", "svk"), personId: child }, activity.id, child, {
          status: j % 4 === 3 ? "not_attending" : "attending",
        });
      }
    }
    // Elsa: Anna said she is coming to the first match; Mikael changed it later.
    const match = f2017.find((a) => a.kind === "match");
    if (match) {
      await s.attendance.respond(as("anna", "svk"), match.id, id("elsa"), { status: "attending" });
      await s.attendance.respond(as("mikael", "svk"), match.id, id("elsa"), {
        status: "not_attending",
        note: "Förkyld, stannar hemma.",
      });
    }
    // IKN F2015: Erik for Maja, Samira for Nadia (counted, never named for other parents).
    for (const activity of await coming("ikn", "ikn-f2015")) {
      await s.attendance.respond(as("erik", "ikn"), activity.id, id("maja"), {
        status: "attending",
      });
      await s.attendance.respond(as("samira", "ikn"), activity.id, id("nadia"), {
        status: "attending",
      });
    }
    // IKN P2012's match in five days asks for answers by the day before; Oskar and Liam answered.
    const p2012Match = (await coming("ikn", "ikn-p2012")).find((a) => a.kind === "match");
    if (p2012Match) {
      await s.activities.updateActivity(as("karin", "ikn"), p2012Match.id, {
        responseMode: "requested",
        respondBy: new Date(p2012Match.startsAt.getTime() - DAY_MS).toISOString(),
      });
      await s.attendance.respond(as("oskar", "ikn"), p2012Match.id, id("oskar"), {
        status: "attending",
      });
      await s.attendance.respond(as("liam", "ikn"), p2012Match.id, id("liam"), {
        status: "not_attending",
        note: "Bortrest med familjen.",
      });
      // Karin calls up a squad (#19): Oskar and every other generated player.
      // Liam is not called up; his answer stays and is no longer counted.
      const squad = (core.generated.get("ikn-p2012") ?? []).filter((_, i) => i % 2 === 0);
      await s.attendance.setInvitees(as("karin", "ikn"), p2012Match.id, {
        inviteesOnly: true,
        personIds: [id("oskar"), ...squad],
      });
    }

    // --- Attendance for past sessions ---------------------------------------------------
    const f2017Past = (await calendar("svk", "svk-f2017", -10 * 7 * DAY_MS, -HOUR_MS)).filter(
      (a) => a.status === "scheduled",
    );
    // One session ended early (below 45 minutes), detached from its series.
    const short = f2017Past.find(
      (a) => a.kind === "training" && a.startsAt.getTime() < now.getTime() - 35 * DAY_MS,
    );
    if (short) {
      await s.activities.updateActivity(as("erik", "svk"), short.id, {
        endsAt: new Date(short.startsAt.getTime() + 40 * 60_000).toISOString(),
        notes: "Avbröts efter 40 minuter (brandlarm i hallen).",
      });
    }
    const thin = f2017Past.filter((a) => a.kind === "training").at(-3);
    // The F2017 session nearest to 40 days ago (Alva's mark there is corrected).
    const target = now.getTime() - 40 * DAY_MS;
    const fortyDaysAgo = [...f2017Past].sort(
      (a, b) => Math.abs(a.startsAt.getTime() - target) - Math.abs(b.startsAt.getTime() - target),
    )[0];
    const guest = core.generated.get("svk-minivolley")?.[0];

    for (const team of TEAMS) {
      const past = (await calendar(team.club, team.group, -10 * 7 * DAY_MS, -HOUR_MS)).filter(
        (a) => a.status === "scheduled",
      );
      for (const [i, activity] of past.entries()) {
        const taken = new Date(activity.endsAt.getTime() + 10 * 60_000);
        const service = at(taken);
        const ctx = as(team.leader, team.club, taken);
        const sheet = await service.getAttendance(ctx, activity.id);
        const marks: {
          personId: string;
          status: AttendanceStatus;
          role: "participant" | "leader";
        }[] = [];
        for (const [j, p] of sheet.participants.entries()) {
          let status: AttendanceStatus =
            p.suggested === "excused"
              ? "excused"
              : (i + j) % 9 === 4
                ? "absent"
                : (i + j) % 13 === 6
                  ? "excused"
                  : "present";
          if (activity.id === thin?.id) status = j < 2 ? "present" : "absent";
          // Alva was marked absent 40 days ago by mistake (corrected below).
          if (p.personId === id("alva") && activity.id === fortyDaysAgo?.id) status = "absent";
          marks.push({ personId: p.personId, status, role: "participant" });
        }
        for (const l of sheet.leaders)
          marks.push({ personId: l.personId, status: "present", role: "leader" });
        if (team.group === "svk-f2017" && guest && i === 2) {
          marks.push({ personId: guest, status: "present", role: "participant" });
        }
        if (marks.length === 0) continue;
        await service.recordAttendance(
          ctx,
          activity.id,
          { marks: marks.map((m) => ({ ...m, recordedAt: taken.toISOString() })) },
          { leads: true, corrects: false },
        );
      }
    }

    // Sara (club manager) corrects Alva's mark 40 days ago, after the lock.
    if (fortyDaysAgo) {
      await s.attendance.recordAttendance(
        as("sara", "svk"),
        fortyDaysAgo.id,
        {
          marks: [{ personId: id("alva"), status: "present" }],
          correctedReason: "Fel markering",
        },
        { leads: true, corrects: true },
      );
    }
  },
};
