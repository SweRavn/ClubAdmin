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
import { RolesModule, RolesService } from "../roles/index.ts";
import { InvitationsController } from "./invitations.controller.ts";
import { InvitationsService } from "./invitations.service.ts";
import { JoinRequestsService } from "./join-requests.service.ts";
import { JoiningController } from "./joining.controller.ts";

@Module({
  imports: [
    AccountsModule,
    AuthorizationModule,
    ClubsModule,
    GroupsModule,
    MembershipsModule,
    PeopleModule,
    RolesModule,
  ],
  controllers: [JoiningController, InvitationsController],
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
      provide: InvitationsService,
      inject: [
        DATABASE,
        API_CONFIG,
        ClubsService,
        GroupsService,
        MembershipsService,
        RolesService,
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
        accounts: AccountsService,
        joinRequests: JoinRequestsService,
      ) =>
        new InvitationsService(requireDatabase(db), {
          clubs,
          groups,
          memberships,
          roles,
          accounts,
          joinRequests,
          tokenKey: config.INVITATION_TOKEN_KEY,
          webUrl: config.PUBLIC_WEB_URL,
        }),
    },
  ],
  exports: [JoinRequestsService, InvitationsService],
})
export class JoiningModule {}
