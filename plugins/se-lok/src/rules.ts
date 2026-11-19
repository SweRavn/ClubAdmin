// SPDX-License-Identifier: AGPL-3.0-only
// RF's LOK rules, versioned by the date of the activity (ADR 0051 decision
// 5). Source: "Föreskrifter om statligt lokalt aktivitetsstöd", fastställda
// av RS 2025-05-22, in force from 1 July 2025:
// https://www.rf.se/download/18.541eee07197627cf1f795bb9/1750073010580/LOK-st%C3%B6dsf%C3%B6reskrifter%2020250522.pdf
// Activities before the first version are outside the rules (no session
// before 2025 is reported; decision 2026-11-12). A later version is added
// beside this one with its own `validFrom`.

export interface LokRules {
  /** The first activity date the version applies to. */
  validFrom: string;
  /** § 5: at least this many participants active at the same time. */
  minParticipants: number;
  /** § 5: for at least this many minutes (a municipal variant may ask for more). */
  minMinutes: number;
  /** § 5: an appointed leader of at least this age (turned in the calendar year). */
  leaderMinAge: number;
  /** § 5: support for at most this many participants per leader present. */
  participantsPerLeader: number;
  /** § 6: participants who turn this age at the least in the calendar year. */
  participantMinAge: number;
  /** § 6: and at the most (no upper age with a disability). */
  participantMaxAge: number;
  /** § 6: leaders who turn this old at the most also count as participants. */
  leaderParticipantMaxAge: number;
  /** § 6: occasions per person, SF sport and calendar week, by age band. */
  weeklyCaps: readonly { maxAge: number; cap: number }[];
  /** § 6: the weight (multiples of Z) of the 1st, 2nd, … occasion in a week, by band. */
  weights: readonly { maxAge: number; units: readonly number[] }[];
}

export const RULES_2025_07_01: LokRules = {
  validFrom: "2025-07-01",
  minParticipants: 3,
  minMinutes: 45,
  leaderMinAge: 13,
  participantsPerLeader: 20,
  participantMinAge: 6,
  participantMaxAge: 25,
  leaderParticipantMaxAge: 25,
  // 6–9: at most 3 a week; 10–25 (and 26+ with a disability, leaders 13–25): 5.
  weeklyCaps: [
    { maxAge: 9, cap: 3 },
    { maxAge: Number.POSITIVE_INFINITY, cap: 5 },
  ],
  // 6–9: 3Z, 3Z, 2Z; 10–25: 3Z, 3Z, 2Z, Z, Z (26+ with a disability and leaders 13–25 as 10–25).
  weights: [
    { maxAge: 9, units: [3, 3, 2] },
    { maxAge: Number.POSITIVE_INFINITY, units: [3, 3, 2, 1, 1] },
  ],
};

/** Every version, oldest first. */
export const RULE_VERSIONS: readonly LokRules[] = [RULES_2025_07_01];

/** The version an activity on `date` falls under (null: before the rules). */
export function rulesFor(
  date: string,
  versions: readonly LokRules[] = RULE_VERSIONS,
): LokRules | null {
  let found: LokRules | null = null;
  for (const v of versions) if (v.validFrom <= date) found = v;
  return found;
}

/** The age a person turns in the calendar year of `date` (§ 6 counts by calendar year). */
export function ageInYear(birthDate: string, date: string): number {
  return Number(date.slice(0, 4)) - Number(birthDate.slice(0, 4));
}

/**
 * § 7 and § 8: two periods a year; the spring period is due 25 August, the
 * autumn period 25 February. Late applications lose 25, 50 or 75 per cent,
 * and are refused from 1 October respectively 1 April.
 */
export function periodsOf(year: number) {
  return [
    {
      key: `${year}-1`,
      from: `${year}-01-01`,
      to: `${year}-06-30`,
      referenceDate: null,
      deadline: `${year}-08-25`,
      late: [
        { until: `${year}-09-01`, percent: 25 },
        { until: `${year}-09-15`, percent: 50 },
        { until: `${year}-09-30`, percent: 75 },
      ],
      refusedAfter: `${year}-09-30`,
    },
    {
      key: `${year}-2`,
      from: `${year}-07-01`,
      to: `${year}-12-31`,
      referenceDate: null,
      deadline: `${year + 1}-02-25`,
      late: [
        { until: `${year + 1}-03-01`, percent: 25 },
        { until: `${year + 1}-03-15`, percent: 50 },
        { until: `${year + 1}-03-31`, percent: 75 },
      ],
      refusedAfter: `${year + 1}-03-31`,
    },
  ];
}

/** ISO week key (year-week) of a date, Monday to Sunday. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}
