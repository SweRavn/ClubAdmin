// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubProfilesModule, ClubProfilesService } from "../club-profiles/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { GroupsModule, GroupsService } from "../groups/index.ts";
import { PeopleModule } from "../people/index.ts";
import { RolesModule, RolesService } from "../roles/index.ts";
import { GroupMembersController } from "./group-members.controller.ts";
import { MembershipsService } from "./memberships.service.ts";

@Module({
  imports: [
    AuthorizationModule,
    ClubsModule,
    ClubProfilesModule,
    GroupsModule,
    PeopleModule,
    RolesModule,
  ],
  controllers: [GroupMembersController],
  providers: [
    {
      provide: MembershipsService,
      inject: [DATABASE, ClubsService, ClubProfilesService, GroupsService, RolesService],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        profiles: ClubProfilesService,
        groups: GroupsService,
        roles: RolesService,
      ) => new MembershipsService(requireDatabase(db), { clubs, profiles, groups, roles }),
    },
  ],
  exports: [MembershipsService],
})
export class MembershipsModule {}
