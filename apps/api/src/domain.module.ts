// SPDX-License-Identifier: AGPL-3.0-only
// The core domain modules (P0.5) and their read endpoints (P0.7).
import { Module } from "@nestjs/common";

import { AccountsModule } from "./modules/accounts/index.ts";
import { ActivitiesModule } from "./modules/activities/index.ts";
import { AdministratorsModule } from "./modules/administrators/index.ts";
import { AuditModule } from "./modules/audit/index.ts";
import { BackupsModule } from "./modules/backups/index.ts";
import { CalendarModule } from "./modules/calendar/index.ts";
import { ChatModule } from "./modules/chat/index.ts";
import { ClubProfilesModule } from "./modules/club-profiles/index.ts";
import { ClubTypesModule } from "./modules/club-types/index.ts";
// Not in the clubs module's index: it depends on the roles module, which depends on clubs.
import { ClubsApiModule } from "./modules/clubs/clubs-api.module.ts";
import { ClubsModule } from "./modules/clubs/index.ts";
import { EventsModule } from "./modules/events/index.ts";
import { FamiliesModule } from "./modules/families/index.ts";
import { GroupsModule } from "./modules/groups/index.ts";
import { GuardianshipsModule } from "./modules/guardianships/index.ts";
import { JoiningModule } from "./modules/joining/index.ts";
import { MembersModule } from "./modules/members/index.ts";
import { MembershipsModule } from "./modules/memberships/index.ts";
import { NotificationsModule } from "./modules/notifications/index.ts";
import { OnboardingModule } from "./modules/onboarding/index.ts";
import { PeopleModule } from "./modules/people/index.ts";
import { PersonMergeModule } from "./modules/person-merge/index.ts";
import { PersonProfilesModule } from "./modules/person-profiles/index.ts";
import { PrivacyModule } from "./modules/privacy/index.ts";
import { ProtectionModule } from "./modules/protection/index.ts";
import { ClubRolesModule, RolesModule } from "./modules/roles/index.ts";

const MODULES = [
  PeopleModule,
  PersonMergeModule,
  AccountsModule,
  ClubsModule,
  ClubsApiModule,
  OnboardingModule,
  ClubTypesModule,
  RolesModule,
  ClubRolesModule,
  AdministratorsModule,
  ClubProfilesModule,
  GroupsModule,
  MembershipsModule,
  GuardianshipsModule,
  FamiliesModule,
  JoiningModule,
  MembersModule,
  ActivitiesModule,
  EventsModule,
  CalendarModule,
  ChatModule,
  ProtectionModule,
  PersonProfilesModule,
  NotificationsModule,
  PrivacyModule,
  AuditModule,
  BackupsModule,
];

@Module({ imports: MODULES, exports: MODULES })
export class DomainModule {}
