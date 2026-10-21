// SPDX-License-Identifier: AGPL-3.0-only
// The core domain services wired by hand (the same graph Nest builds in
// DomainModule), for code that runs without Nest: the demo seed
// (src/seed) and integration tests (testing/services.ts).

import type { Database } from "@clubadmin/db";

import { AccountsService } from "./modules/accounts/index.ts";
import { ClubProfilesService } from "./modules/club-profiles/index.ts";
import { ClubsService } from "./modules/clubs/index.ts";
import { GroupsService } from "./modules/groups/index.ts";
import { GuardianshipsService } from "./modules/guardianships/index.ts";
import { MembershipsService } from "./modules/memberships/index.ts";
import { OnboardingService } from "./modules/onboarding/index.ts";
import { PeopleService } from "./modules/people/index.ts";
import { PersonMergeService } from "./modules/person-merge/index.ts";
import { RolesService } from "./modules/roles/index.ts";
import type { FieldEncryption } from "./platform/crypto/field-encryption.ts";

export interface CoreServices {
  encryption: FieldEncryption;
  people: PeopleService;
  merge: PersonMergeService;
  accounts: AccountsService;
  clubs: ClubsService;
  onboarding: OnboardingService;
  roles: RolesService;
  profiles: ClubProfilesService;
  groups: GroupsService;
  memberships: MembershipsService;
  guardianships: GuardianshipsService;
}

export function createCoreServices(
  db: Database,
  options: { encryption: FieldEncryption; defaultCountry?: string },
): CoreServices {
  const { encryption } = options;
  const people = new PeopleService(db, encryption);
  const clubs = new ClubsService(db);
  const roles = new RolesService(db, clubs);
  const profiles = new ClubProfilesService(db);
  const groups = new GroupsService(db, clubs);
  const memberships = new MembershipsService(db, { clubs, profiles, groups, roles });
  return {
    encryption,
    people,
    merge: new PersonMergeService(db, { people, profiles }),
    accounts: new AccountsService(db, {
      people,
      memberships,
      clubs,
      defaultCountry: options.defaultCountry ?? "SE",
    }),
    clubs,
    onboarding: new OnboardingService(db, { clubs, memberships, roles }),
    roles,
    profiles,
    groups,
    memberships,
    guardianships: new GuardianshipsService(db, people),
  };
}
