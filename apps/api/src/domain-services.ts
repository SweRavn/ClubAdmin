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
import { InvitationsService, JoinRequestsService } from "./modules/joining/index.ts";
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
  joinRequests: JoinRequestsService;
  invitations: InvitationsService;
}

export function createCoreServices(
  db: Database,
  options: {
    encryption: FieldEncryption;
    defaultCountry?: string;
    invitationTokenKey?: string;
    webUrl?: string;
  },
): CoreServices {
  const { encryption } = options;
  const people = new PeopleService(db, encryption);
  const clubs = new ClubsService(db);
  const roles = new RolesService(db, clubs);
  const profiles = new ClubProfilesService(db);
  const groups = new GroupsService(db, clubs);
  const memberships = new MembershipsService(db, { clubs, profiles, groups, roles });
  const defaultCountry = options.defaultCountry ?? "SE";
  const accounts = new AccountsService(db, { people, memberships, clubs, defaultCountry });
  const joinRequests = new JoinRequestsService(db, { clubs, groups, memberships, accounts });
  return {
    encryption,
    people,
    merge: new PersonMergeService(db, { people, profiles }),
    accounts,
    clubs,
    onboarding: new OnboardingService(db, {
      clubs,
      memberships,
      roles,
      people,
      accounts,
      defaultCountry,
    }),
    joinRequests,
    invitations: new InvitationsService(db, {
      clubs,
      groups,
      memberships,
      roles,
      accounts,
      joinRequests,
      tokenKey: options.invitationTokenKey,
      webUrl: options.webUrl ?? "https://clubadmin.localhost",
    }),
    roles,
    profiles,
    groups,
    memberships,
    guardianships: new GuardianshipsService(db, people),
  };
}
