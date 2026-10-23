// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { FIELD_ENCRYPTION, type FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "../../platform/infra/object-storage.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubProfilesModule, ClubProfilesService } from "../club-profiles/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { GroupsModule, GroupsService } from "../groups/index.ts";
import { GuardianshipsModule, GuardianshipsService } from "../guardianships/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { MemberExportsController } from "./member-exports.controller.ts";
import { MemberImportsController } from "./member-imports.controller.ts";
import { MemberImportsService } from "./member-imports.service.ts";
import { MemberIntakeService } from "./member-intake.service.ts";
import { MembersController } from "./members.controller.ts";
import { MembersService } from "./members.service.ts";

@Module({
  imports: [
    AuthorizationModule,
    MembershipsModule,
    PeopleModule,
    GroupsModule,
    GuardianshipsModule,
    AccountsModule,
    ClubsModule,
    ClubProfilesModule,
  ],
  controllers: [MembersController, MemberExportsController, MemberImportsController],
  providers: [
    {
      provide: MembersService,
      inject: [DATABASE, OBJECT_STORAGE, API_CONFIG],
      useFactory: (db: OptionalDatabase, storage: OptionalObjectStorage, config: ApiConfig) =>
        new MembersService(requireDatabase(db), storage, {
          exportsPerPersonPerDay: config.MEMBER_EXPORTS_PER_PERSON_DAY,
          exportsPerClubPerDay: config.MEMBER_EXPORTS_PER_CLUB_DAY,
        }),
    },
    {
      provide: MemberIntakeService,
      inject: [
        DATABASE,
        PeopleService,
        MembershipsService,
        GroupsService,
        GuardianshipsService,
        AccountsService,
        ClubsService,
      ],
      useFactory: (
        db: OptionalDatabase,
        people: PeopleService,
        memberships: MembershipsService,
        groups: GroupsService,
        guardianships: GuardianshipsService,
        accounts: AccountsService,
        clubs: ClubsService,
      ) =>
        new MemberIntakeService(requireDatabase(db), {
          people,
          memberships,
          groups,
          guardianships,
          accounts,
          clubs,
        }),
    },
    {
      provide: MemberImportsService,
      inject: [
        DATABASE,
        OBJECT_STORAGE,
        FIELD_ENCRYPTION,
        API_CONFIG,
        MemberIntakeService,
        PeopleService,
        ClubsService,
        GroupsService,
        ClubProfilesService,
      ],
      useFactory: (
        db: OptionalDatabase,
        storage: OptionalObjectStorage,
        encryption: FieldEncryption,
        config: ApiConfig,
        intake: MemberIntakeService,
        people: PeopleService,
        clubs: ClubsService,
        groups: GroupsService,
        profiles: ClubProfilesService,
      ) =>
        new MemberImportsService(
          requireDatabase(db),
          { storage, encryption, intake, people, clubs, groups, profiles },
          {
            importsPerClubPerDay: config.MEMBER_IMPORTS_PER_CLUB_DAY,
            invitationsPerClubPerDay: config.MEMBER_IMPORT_INVITATIONS_PER_CLUB_DAY,
            batchConcurrency: config.MEMBER_IMPORT_BATCH_CONCURRENCY,
          },
        ),
    },
  ],
  exports: [MembersService, MemberIntakeService, MemberImportsService],
})
export class MembersModule {}
