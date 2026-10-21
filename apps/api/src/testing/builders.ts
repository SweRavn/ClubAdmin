// SPDX-License-Identifier: AGPL-3.0-only
// Small fixture builders for tests, writing through the domain services so
// invariants, audit events and history are produced as in real use. The full
// demo scenario is the seed (P0.8).

import type { ActorContext, TenantContext } from "@clubadmin/db";
import { type CreateClubInput, type CreatePersonInput, uuidv7 } from "@clubadmin/shared";

import type { Club } from "../modules/clubs/index.ts";
import type { Guardianship } from "../modules/guardianships/index.ts";
import type { Person } from "../modules/people/index.ts";
import type { CoreServices } from "./services.ts";

let counter = 0;
const next = () => ++counter;

/** Context of a person acting as themselves, optionally in a club. */
export function actor(personId: string): ActorContext;
export function actor(personId: string, clubId: string): TenantContext;
export function actor(personId: string, clubId?: string): ActorContext | TenantContext {
  const base = { actorKind: "person" as const, personId, requestId: `test-${uuidv7()}` };
  return clubId ? { ...base, clubId } : base;
}

export interface BuiltPerson extends Person {
  email: string | null;
  as(clubId?: string): ActorContext | TenantContext;
}

/** An adult who signed up: a person with an account (unique .test email). */
export async function buildPerson(
  services: CoreServices,
  overrides: Partial<CreatePersonInput> & { email?: string | null } = {},
): Promise<BuiltPerson> {
  const id = uuidv7();
  const self = actor(id);
  const { email: emailOverride, ...personOverrides } = overrides;
  const n = next();
  await services.people.createSelf(self, {
    givenName: `Given${n}`,
    familyName: `Family${n}`,
    birthDate: "1985-04-12",
    ...personOverrides,
  });
  return finishPerson(
    services,
    id,
    emailOverride === undefined ? `person${n}-${id.slice(-8)}@example.test` : emailOverride,
  );
}

async function finishPerson(
  services: CoreServices,
  id: string,
  email: string | null,
): Promise<BuiltPerson> {
  const self = actor(id);
  if (email) await services.accounts.createAccount(self, { email, emailVerifiedAt: new Date() });
  const person = await services.people.getPerson(self, id);
  return {
    ...person,
    email,
    as: (clubId?: string) => (clubId ? actor(id, clubId) : actor(id)),
  };
}

export interface BuiltClub extends Club {
  manager: BuiltPerson;
  /** Context of the manager in this club. */
  ctx: TenantContext;
}

/** A club created by a new person, who becomes manager and member #1. */
export async function buildClub(
  services: CoreServices,
  overrides: Partial<CreateClubInput> & { manager?: BuiltPerson } = {},
): Promise<BuiltClub> {
  const { manager: given, ...clubOverrides } = overrides;
  const manager = given ?? (await buildPerson(services));
  const n = next();
  const club = await services.onboarding.createClub(actor(manager.id), {
    name: `Test Club ${n}`,
    slug: `test-club-${n}-${uuidv7().slice(-8)}`,
    country: "SE",
    ...clubOverrides,
  });
  return { ...club, manager, ctx: actor(manager.id, club.id) };
}

export interface BuiltFamily {
  guardian: BuiltPerson;
  coGuardian: BuiltPerson;
  child: Person;
  guardianships: Guardianship[];
}

/** Two guardians (both with accounts) and a child without account or email. */
export async function buildFamily(
  services: CoreServices,
  options: { childBirthDate?: string; club?: BuiltClub } = {},
): Promise<BuiltFamily> {
  const guardian = await buildPerson(services);
  const coGuardian = await buildPerson(services);
  const { child, guardianship } = await services.guardianships.addChild(actor(guardian.id), {
    givenName: `Child${next()}`,
    familyName: guardian.familyName,
    birthDate: options.childBirthDate ?? "2016-03-01",
  });
  const { token } = await services.guardianships.inviteCoGuardian(actor(guardian.id), {
    wardPersonId: child.id,
    email: coGuardian.email!,
  });
  const second = await services.guardianships.acceptInvitation(actor(coGuardian.id), token);
  if (options.club) {
    await services.memberships.addMember(options.club.ctx, child.id);
  }
  return { guardian, coGuardian, child, guardianships: [guardianship, second] };
}
