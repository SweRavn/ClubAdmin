// SPDX-License-Identifier: AGPL-3.0-only
// The core domain modules (P0.5). They have no HTTP endpoints yet; endpoints
// come with authorization (P0.7).
import { Module } from "@nestjs/common";

import { AccountsModule } from "./modules/accounts/index.ts";
import { ClubProfilesModule } from "./modules/club-profiles/index.ts";
import { ClubsModule } from "./modules/clubs/index.ts";
import { GroupsModule } from "./modules/groups/index.ts";
import { GuardianshipsModule } from "./modules/guardianships/index.ts";
import { MembershipsModule } from "./modules/memberships/index.ts";
import { OnboardingModule } from "./modules/onboarding/index.ts";
import { PeopleModule } from "./modules/people/index.ts";
import { PersonMergeModule } from "./modules/person-merge/index.ts";
import { RolesModule } from "./modules/roles/index.ts";

const MODULES = [
  PeopleModule,
  PersonMergeModule,
  AccountsModule,
  ClubsModule,
  OnboardingModule,
  RolesModule,
  ClubProfilesModule,
  GroupsModule,
  MembershipsModule,
  GuardianshipsModule,
];

@Module({ imports: MODULES, exports: MODULES })
export class DomainModule {}
