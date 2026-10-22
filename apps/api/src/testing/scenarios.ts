// SPDX-License-Identifier: AGPL-3.0-only
// The "matrix" scenario (P0.7): one person per kind of relationship, for the
// permission matrix and protected-identity tests. Written through the domain
// services like the builders; operators are created as operator tooling
// would (there is no API for it).
//
// Club A: section S > team T. manager (club manager), registrar, owner (of S,
// so of T too), coach (head coach of T), member (adult in T), child (in T,
// no login) with parent (full guardian) and relative (view_schedule only),
// protectedMember (adult in T, global protected flag). Club B: outsider
// (its manager). operator: platform operator without support access.

import { sql } from "@clubadmin/db";
import type { TestDatabase } from "@clubadmin/db/testing";

import type { Group } from "../modules/groups/index.ts";
import type { Person } from "../modules/people/index.ts";
import { actor, buildClub, buildPerson, type BuiltClub, type BuiltPerson } from "./builders.ts";
import type { CoreServices } from "./services.ts";

export interface MatrixScenario {
  clubA: BuiltClub;
  clubB: BuiltClub;
  section: Group;
  team: Group;
  otherTeam: Group;
  manager: BuiltPerson;
  registrar: BuiltPerson;
  owner: BuiltPerson;
  coach: BuiltPerson;
  member: BuiltPerson;
  protectedMember: BuiltPerson;
  parent: BuiltPerson;
  relative: BuiltPerson;
  child: Person;
  /** The child's sibling (parent's ward, member of club A, no group): target of family writes in the matrix. */
  sibling: Person;
  /** The relative's guardianship of the child (view_schedule only). */
  relativeGuardianshipId: string;
  outsider: BuiltPerson;
  operator: BuiltPerson;
}

export const MATRIX_PERSONAS = [
  "manager",
  "registrar",
  "owner",
  "coach",
  "member",
  "parent",
  "relative",
  "outsider",
  "operator",
] as const;
export type MatrixPersona = (typeof MATRIX_PERSONAS)[number];

export async function buildMatrixScenario(
  s: CoreServices,
  t: TestDatabase,
): Promise<MatrixScenario> {
  const clubA = await buildClub(s);
  const clubB = await buildClub(s);
  const a = clubA.ctx;
  const section = await s.groups.createGroup(a, { name: "Fotboll", kind: "section" });
  const team = await s.groups.createGroup(a, {
    name: "F2016",
    kind: "team",
    parentGroupId: section.id,
  });
  const otherTeam = await s.groups.createGroup(a, { name: "P2014", kind: "team" });

  const join = async (overrides: Parameters<typeof buildPerson>[1] = {}) => {
    const person = await buildPerson(s, overrides);
    await s.memberships.addMember(a, person.id);
    return person;
  };
  const registrar = await join();
  await s.roles.assignRole(a, registrar.id, "registrar");
  const owner = await join();
  await s.groups.addOwner(a, section.id, owner.id, "club_manager");
  const coach = await join();
  await s.memberships.addToGroup(a, team.id, coach.id, "head_coach");
  const member = await join();
  await s.memberships.addToGroup(a, team.id, member.id);
  const protectedMember = await join({ protectedIdentity: true });
  await s.memberships.addToGroup(a, team.id, protectedMember.id);

  const parent = await buildPerson(s);
  const { child } = await s.guardianships.addChild(actor(parent.id), {
    givenName: "Liv",
    familyName: parent.familyName,
    birthDate: "2016-05-01",
  });
  const relative = await buildPerson(s);
  const relativeGuardianship = await s.guardianships.addGuardian(actor(parent.id), {
    guardianPersonId: relative.id,
    wardPersonId: child.id,
    kind: "relative",
  });
  await s.memberships.addMember(a, child.id);
  await s.memberships.addToGroup(a, team.id, child.id);
  const { child: sibling } = await s.guardianships.addChild(actor(parent.id), {
    givenName: "Siv",
    familyName: parent.familyName,
    birthDate: "2018-02-01",
  });
  await s.memberships.addMember(a, sibling.id);

  const operator = await buildPerson(s);
  await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator.id]);

  return {
    clubA,
    clubB,
    section,
    team,
    otherTeam,
    manager: clubA.manager,
    registrar,
    owner,
    coach,
    member,
    protectedMember,
    parent,
    relative,
    child,
    sibling,
    relativeGuardianshipId: relativeGuardianship.id,
    outsider: clubB.manager,
    operator,
  };
}

/** Time-limited support access for an operator, granted by the club's manager. */
export async function grantSupportAccess(
  t: TestDatabase,
  club: BuiltClub,
  operatorPersonId: string,
  interval = "1 hour",
): Promise<void> {
  await t.db.withTenant(club.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO support_access_grants (club_id, operator_person_id, granted_by_person_id, reason, expires_at)
      VALUES (${club.id}, ${operatorPersonId}, ${club.manager.id}, 'Support case', now() + ${interval}::interval)`),
  );
}
