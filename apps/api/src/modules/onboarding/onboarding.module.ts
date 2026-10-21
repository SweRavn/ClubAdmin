// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { RolesModule, RolesService } from "../roles/index.ts";
import { OnboardingService } from "./onboarding.service.ts";

@Module({
  imports: [ClubsModule, MembershipsModule, RolesModule],
  providers: [
    {
      provide: OnboardingService,
      inject: [DATABASE, ClubsService, MembershipsService, RolesService],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        memberships: MembershipsService,
        roles: RolesService,
      ) => new OnboardingService(requireDatabase(db), { clubs, memberships, roles }),
    },
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
