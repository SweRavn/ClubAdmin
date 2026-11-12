// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubTypesModule, ClubTypesService } from "../club-types/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { InvitationsService, JoiningModule } from "../joining/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { RolesModule, RolesService } from "../roles/index.ts";
import { ManagersController } from "./managers.controller.ts";
import { OnboardingController } from "./onboarding.controller.ts";
import { OnboardingService } from "./onboarding.service.ts";

@Module({
  imports: [
    AccountsModule,
    AuthorizationModule,
    ClubsModule,
    ClubTypesModule,
    JoiningModule,
    MembershipsModule,
    PeopleModule,
    RolesModule,
  ],
  controllers: [OnboardingController, ManagersController],
  providers: [
    {
      provide: OnboardingService,
      inject: [
        DATABASE,
        API_CONFIG,
        ClubsService,
        ClubTypesService,
        MembershipsService,
        RolesService,
        PeopleService,
        AccountsService,
        InvitationsService,
      ],
      useFactory: (
        db: OptionalDatabase,
        config: ApiConfig,
        clubs: ClubsService,
        clubTypes: ClubTypesService,
        memberships: MembershipsService,
        roles: RolesService,
        people: PeopleService,
        accounts: AccountsService,
        invitations: InvitationsService,
      ) =>
        new OnboardingService(requireDatabase(db), {
          clubs,
          clubTypes,
          memberships,
          roles,
          people,
          accounts,
          invitations,
          defaultCountry: config.DEFAULT_COUNTRY,
        }),
    },
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
