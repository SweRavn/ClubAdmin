// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { GroupsModule, GroupsService } from "../groups/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { ClubRolesModule, ClubRolesService, RolesModule, RolesService } from "../roles/index.ts";
import { InvitationsController } from "./invitations.controller.ts";
import { InvitationsService } from "./invitations.service.ts";
import { JoinRequestsService } from "./join-requests.service.ts";
import { JoiningController } from "./joining.controller.ts";
import { WaitlistsController } from "./waitlists.controller.ts";
import { WaitlistsService } from "./waitlists.service.ts";

@Module({
  imports: [
    AccountsModule,
    AuthorizationModule,
    ClubsModule,
    GroupsModule,
    MembershipsModule,
    PeopleModule,
    RolesModule,
    ClubRolesModule,
  ],
  controllers: [JoiningController, InvitationsController, WaitlistsController],
  providers: [
    {
      provide: JoinRequestsService,
      inject: [DATABASE, ClubsService, GroupsService, MembershipsService, AccountsService],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        groups: GroupsService,
        memberships: MembershipsService,
        accounts: AccountsService,
      ) => new JoinRequestsService(requireDatabase(db), { clubs, groups, memberships, accounts }),
    },
    {
      provide: WaitlistsService,
      inject: [DATABASE, ClubsService, GroupsService, MembershipsService, AccountsService],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        groups: GroupsService,
        memberships: MembershipsService,
        accounts: AccountsService,
      ) => new WaitlistsService(requireDatabase(db), { clubs, groups, memberships, accounts }),
    },
    {
      provide: InvitationsService,
      inject: [
        DATABASE,
        API_CONFIG,
        ClubsService,
        GroupsService,
        MembershipsService,
        RolesService,
        ClubRolesService,
        AccountsService,
        JoinRequestsService,
      ],
      useFactory: (
        db: OptionalDatabase,
        config: ApiConfig,
        clubs: ClubsService,
        groups: GroupsService,
        memberships: MembershipsService,
        roles: RolesService,
        clubRoles: ClubRolesService,
        accounts: AccountsService,
        joinRequests: JoinRequestsService,
      ) =>
        new InvitationsService(requireDatabase(db), {
          clubs,
          groups,
          memberships,
          roles,
          clubRoles,
          accounts,
          joinRequests,
          tokenKey: config.INVITATION_TOKEN_KEY,
          webUrl: config.PUBLIC_WEB_URL,
        }),
    },
  ],
  exports: [JoinRequestsService, InvitationsService, WaitlistsService],
})
export class JoiningModule {}
