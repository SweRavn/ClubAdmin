// SPDX-License-Identifier: AGPL-3.0-only
// The `minimal` scenario: one club with one group, a manager, an adult
// member and the member's child (no login) — for fast manual checks.

import type { ActorContext } from "@clubadmin/db";

import type { SeedEnvironment } from "./environment.ts";

export async function seedMinimal(env: SeedEnvironment): Promise<void> {
  const { services: s, generator, clock } = env;
  const adult = async (email: string) => {
    const person = generator.person("SE");
    const self: ActorContext = {
      actorKind: "person",
      personId: person.id,
      requestId: "seed:minimal",
    };
    await s.people.createSelf(self, {
      givenName: person.givenName,
      familyName: person.familyName,
      birthDate: clock.birthDate(40, "05-01"),
      gender: person.gender,
    });
    await s.accounts.createAccount(self, { email, emailVerifiedAt: clock.now });
    return self;
  };
  const manager = await adult("minimal.manager@example.test");
  const member = await adult("minimal.member@example.test");
  const club = await s.onboarding.createClub(
    manager,
    { name: "Minimala IF", slug: "minimala-if", country: "SE" },
    { id: generator.nextId() },
  );
  const ctx = { ...manager, clubId: club.id };
  const group = await s.groups.createGroup(
    ctx,
    { name: "Lag A", kind: "team" },
    { id: generator.nextId() },
  );
  const childName = generator.person("SE");
  const { child } = await s.guardianships.addChild(
    member,
    {
      givenName: childName.givenName,
      familyName: childName.familyName,
      birthDate: clock.birthDate(10, "09-01"),
    },
    "parent",
    { id: childName.id },
  );
  for (const personId of [member.personId!, child.id]) {
    await s.memberships.addMember(ctx, personId);
    await s.memberships.addToGroup(ctx, group.id, personId);
  }
}
