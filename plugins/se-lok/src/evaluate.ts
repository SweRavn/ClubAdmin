// SPDX-License-Identifier: AGPL-3.0-only
// How a session and a period count for LOK-stöd under RF's rules (rules.ts):
// § 5 the group activity (leader, three participants, 45 minutes, 20 per
// leader, a leader never leading two at once) and § 6 the participant
// support (ages by calendar year, a disability without upper age, leaders
// 13–25, one group activity per person, SF sport and day, 3 or 5 per
// calendar week, the occasions' weights). Pure functions on the plugin
// contract's data; every result names sessions and people by ID with codes.

import type {
  MissingData,
  PeriodEvaluation,
  PluginPerson,
  PluginSession,
  SessionEvaluation,
  Total,
} from "@clubadmin/plugin-api";

import { ageInYear, isoWeek, type LokRules, RULE_VERSIONS, rulesFor } from "./rules.ts";

export interface LokOptions {
  /** A municipal variant's longer minimum (e.g. 60); never shorter than RF's. */
  minMinutes?: number;
  /** The rule versions (tests add a later one). */
  versions?: readonly LokRules[];
}

/** Whether the person is a member of the club on the date (§ 6: participants must be). */
export function memberOn(person: PluginPerson | undefined, date: string): boolean {
  const m = person?.membership;
  if (!m) return false;
  if (m.joinedOn && m.joinedOn > date) return false;
  if (m.leftOn && m.leftOn < date) return false;
  return m.status !== "left" || (m.leftOn !== null && m.leftOn >= date);
}

const endOf = (s: PluginSession) => Date.parse(s.startsAt) + s.durationMinutes * 60_000;
const sportOf = (s: PluginSession) => s.sport ?? `group:${s.groupId}`;
const sorted = (ids: Iterable<string>) => [...ids].sort();

interface Assessment {
  counts: boolean;
  codes: string[];
  /** Leaders present who qualify (13 or older). */
  leaders: string[];
  /** Participants who qualify, capped at 20 per leader. */
  participants: string[];
  /** Leaders who also count as participants (13–25). */
  leaderParticipants: string[];
  rules: LokRules | null;
}

/** § 5 and the participants' § 6 conditions for one session with the leaders it may count. */
function assess(
  session: PluginSession,
  leaderIds: readonly string[],
  people: ReadonlyMap<string, PluginPerson>,
  options: LokOptions,
): Assessment {
  const rules = rulesFor(session.date, options.versions ?? RULE_VERSIONS);
  if (!rules) {
    return {
      counts: false,
      codes: ["lok.outside_rules"],
      leaders: [],
      participants: [],
      leaderParticipants: [],
      rules,
    };
  }
  const codes: string[] = [];
  const minMinutes = Math.max(rules.minMinutes, options.minMinutes ?? 0);
  if (session.durationMinutes < minMinutes) codes.push("lok.too_short");
  const ageOf = (id: string) => {
    const birth = people.get(id)?.birthDate;
    return birth ? ageInYear(birth, session.date) : null;
  };
  const leaders = sorted(
    leaderIds.filter((id) => {
      const age = ageOf(id);
      return age !== null && age >= rules.leaderMinAge;
    }),
  );
  if (leaders.length === 0) codes.push("lok.no_leader");
  const disabled = (id: string) => session.adapted === true || people.get(id)?.disability === true;
  const eligible = sorted(
    (session.participantIds ?? []).filter((id) => {
      if (leaders.includes(id)) return false;
      const age = ageOf(id);
      if (age === null || age < rules.participantMinAge) return false;
      if (age > rules.participantMaxAge && !disabled(id)) return false;
      return memberOn(people.get(id), session.date);
    }),
  );
  if (eligible.length < rules.minParticipants) codes.push("lok.too_few_participants");
  const cap = leaders.length * rules.participantsPerLeader;
  const participants = eligible.slice(0, cap);
  if (eligible.length > cap && leaders.length > 0) codes.push("lok.over_leader_cap");
  if (session.sport === null || session.sport === undefined) codes.push("lok.no_sport");
  const blocking = codes.filter((c) => c !== "lok.over_leader_cap" && c !== "lok.no_sport");
  const leaderParticipants = leaders.filter(
    (id) => (ageOf(id) ?? 99) <= rules.leaderParticipantMaxAge,
  );
  return { counts: blocking.length === 0, codes, leaders, participants, leaderParticipants, rules };
}

/** One session on its own (the attendance view's hint): no caps across sessions. */
export function evaluateSessionAlone(
  session: PluginSession,
  people: readonly PluginPerson[],
  options: LokOptions = {},
): SessionEvaluation {
  const byId = new Map(people.map((p) => [p.id, p]));
  const a = assess(session, session.leaderIds ?? [], byId, options);
  return {
    sessionId: session.id,
    counts: a.counts,
    codes: a.codes,
    countedPersonIds: a.counts ? sorted([...a.participants, ...a.leaderParticipants]) : [],
  };
}

const band = (age: number, disabled: boolean) =>
  age <= 9 ? "6-9" : age <= 25 ? "10-25" : disabled ? "26+" : "10-25";

/** A whole period: leaders never in two places, then the caps per day and week, then the totals. */
export function evaluatePeriodSessions(
  sessions: readonly PluginSession[],
  people: readonly PluginPerson[],
  options: LokOptions = {},
): PeriodEvaluation {
  const byId = new Map(people.map((p) => [p.id, p]));
  const ordered = [...sessions].sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
  );
  const leaderBusy = new Map<string, [number, number][]>();
  const perDay = new Set<string>();
  const perWeek = new Map<string, number>();
  const personCodes = new Map<string, Set<string>>();
  const personCounted = new Map<string, number>();
  const note = (id: string, code: string) => {
    const set = personCodes.get(id) ?? new Set<string>();
    set.add(code);
    personCodes.set(id, set);
  };
  const occasions = new Map<string, number>();
  let units = 0;
  let counted = 0;
  let extraLeader = 0;
  const evaluations: SessionEvaluation[] = [];
  const appearing = new Set<string>();

  for (const session of ordered) {
    for (const id of [...(session.participantIds ?? []), ...(session.leaderIds ?? [])])
      appearing.add(id);
    const start = Date.parse(session.startsAt);
    const end = endOf(session);
    // § 5: a leader is not responsible for two group activities at once.
    const leaders: string[] = [];
    let overlap = false;
    for (const id of session.leaderIds ?? []) {
      const busy = leaderBusy.get(id) ?? [];
      if (busy.some(([s, e]) => s < end && start < e)) {
        overlap = true;
        continue;
      }
      leaders.push(id);
    }
    const a = assess(session, leaders, byId, options);
    const codes = overlap ? [...a.codes, "lok.leader_overlap"] : a.codes;
    if (!a.counts || !a.rules) {
      evaluations.push({ sessionId: session.id, counts: false, codes, countedPersonIds: [] });
      continue;
    }
    for (const id of a.leaders) leaderBusy.set(id, [...(leaderBusy.get(id) ?? []), [start, end]]);
    counted += 1;
    if (a.leaders.length >= 2) extraLeader += 1;
    const rules = a.rules;
    const sport = sportOf(session);
    const week = isoWeek(session.date);
    const countedHere: string[] = [];
    for (const id of sorted([...a.participants, ...a.leaderParticipants])) {
      const person = byId.get(id);
      const age = ageInYear(person!.birthDate!, session.date);
      const disabled = session.adapted === true || person?.disability === true;
      // § 6: one group activity per person, SF sport and day.
      const dayKey = `${id}|${sport}|${session.date}`;
      if (perDay.has(dayKey)) {
        note(id, "lok.same_day");
        continue;
      }
      // § 6: 3 (6–9) or 5 (10–25) occasions per SF sport and calendar week.
      const weekKey = `${id}|${sport}|${week}`;
      const used = perWeek.get(weekKey) ?? 0;
      const cap = rules.weeklyCaps.find((c) => age <= c.maxAge)!.cap;
      if (used >= cap) {
        note(id, "lok.week_cap");
        continue;
      }
      perDay.add(dayKey);
      perWeek.set(weekKey, used + 1);
      const weights = rules.weights.find((w) => age <= w.maxAge)!.units;
      units += weights[used] ?? 0;
      personCounted.set(id, (personCounted.get(id) ?? 0) + 1);
      const b = band(age, disabled);
      occasions.set(b, (occasions.get(b) ?? 0) + 1);
      countedHere.push(id);
    }
    evaluations.push({ sessionId: session.id, counts: true, codes, countedPersonIds: countedHere });
  }

  // Why someone present never counted: no birth date, outside the ages, not a member.
  for (const session of ordered) {
    const rules = rulesFor(session.date, options.versions ?? RULE_VERSIONS);
    if (!rules) continue;
    for (const id of session.participantIds ?? []) {
      const person = byId.get(id);
      if (!person?.birthDate) {
        note(id, "lok.no_birth_date");
        continue;
      }
      const age = ageInYear(person.birthDate, session.date);
      const disabled = session.adapted === true || person.disability === true;
      if (age < rules.participantMinAge || (age > rules.participantMaxAge && !disabled)) {
        note(id, "lok.age_outside");
      } else if (!memberOn(person, session.date)) {
        note(id, "lok.not_member");
      }
    }
  }

  const missing: MissingData[] = [];
  for (const id of sorted(appearing)) {
    const p = byId.get(id);
    if (!p) continue;
    if (!p.birthDate) missing.push({ personId: id, field: "birthDate" });
    if (!p.personalIdentityNumber) missing.push({ personId: id, field: "personalIdentityNumber" });
    if (!p.sex) missing.push({ personId: id, field: "sex" });
  }
  const totals: Total[] = [
    { measure: "lok.sessions", dimensions: {}, value: counted },
    { measure: "lok.extra_leader_support", dimensions: {}, value: extraLeader },
    ...["6-9", "10-25", "26+"]
      .filter((b) => occasions.has(b))
      .map((b) => ({
        measure: "lok.participant_occasions",
        dimensions: { age: b },
        value: occasions.get(b)!,
      })),
    { measure: "lok.units", dimensions: {}, value: units },
  ];
  return {
    sessions: evaluations,
    people: sorted(new Set([...appearing, ...personCodes.keys()]))
      .filter((id) => byId.has(id))
      .map((personId) => ({
        personId,
        counted: personCounted.get(personId) ?? 0,
        codes: sorted(personCodes.get(personId) ?? []),
      })),
    totals,
    missing,
  };
}
