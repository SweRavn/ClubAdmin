// SPDX-License-Identifier: AGPL-3.0-only
// Sample people and sessions for the conformance suite and the scenarios:
// every field filled, as the host would before minimising.

import type { PluginPerson, PluginSession } from "../src/index.ts";

let n = 0;
export const uuid = (kind: number) =>
  `0199a000-0000-7000-80${String(kind).padStart(2, "0")}-${String(++n).padStart(12, "0")}`;

export const GROUP = "0199a000-0000-7000-8002-000000000001";

export function person(over: Partial<PluginPerson> = {}): PluginPerson {
  return {
    id: uuid(0),
    givenName: "Test",
    familyName: "Person",
    birthDate: "2012-05-01",
    sex: "female",
    personalIdentityNumber: "201205012384",
    disability: false,
    homeMunicipality: "0363",
    membership: { status: "active", type: "active", joinedOn: "2020-01-01", leftOn: null },
    membershipFeePaid: true,
    clubRoles: [],
    groups: [{ groupId: GROUP, functions: ["member"], sport: "football", adapted: false }],
    ...over,
  };
}

export function session(over: Partial<PluginSession> = {}): PluginSession {
  return {
    id: uuid(9),
    groupId: GROUP,
    sport: "football",
    adapted: false,
    kind: "training",
    date: "2026-03-10",
    startsAt: "2026-03-10T17:00:00Z",
    durationMinutes: 60,
    participantIds: [],
    leaderIds: [],
    ...over,
  };
}

/** A small club: twelve players born 2012, two leaders, sessions in spring and autumn. */
export function club() {
  const leaders = [person({ birthDate: "1985-01-01" }), person({ birthDate: "2008-02-02" })];
  const players = Array.from({ length: 12 }, (_, i) =>
    person({ birthDate: `2012-0${(i % 9) + 1}-15`, sex: i % 2 ? "male" : "female" }),
  );
  const sessions = ["2026-03-10", "2026-03-12", "2026-09-08"].map((date) =>
    session({
      date,
      startsAt: `${date}T17:00:00Z`,
      participantIds: players.slice(0, 8).map((p) => p.id),
      leaderIds: leaders.map((l) => l.id),
    }),
  );
  return { people: [...leaders, ...players], leaders, players, sessions };
}
