// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { MembershipsModule } from "../memberships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { ActivitiesController } from "./activities.controller.ts";
import { ActivitiesService } from "./activities.service.ts";
import { ScheduleController } from "./schedule.controller.ts";

@Module({
  imports: [AuthorizationModule, ClubsModule, MembershipsModule, PeopleModule],
  controllers: [ActivitiesController, ScheduleController],
  providers: [
    {
      provide: ActivitiesService,
      inject: [DATABASE, ClubsService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService) =>
        new ActivitiesService(requireDatabase(db), clubs),
    },
  ],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
