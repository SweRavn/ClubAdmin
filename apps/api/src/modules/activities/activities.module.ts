// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { ActivitiesController } from "./activities.controller.ts";
import { ActivitiesService } from "./activities.service.ts";
import { AttendanceController } from "./attendance.controller.ts";
import { AttendanceService } from "./attendance.service.ts";
import { ScheduleController } from "./schedule.controller.ts";

@Module({
  imports: [AuthorizationModule, ClubsModule, MembershipsModule, PeopleModule],
  controllers: [ActivitiesController, AttendanceController, ScheduleController],
  providers: [
    {
      provide: ActivitiesService,
      inject: [DATABASE, ClubsService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService) =>
        new ActivitiesService(requireDatabase(db), clubs),
    },
    {
      provide: AttendanceService,
      inject: [DATABASE, ClubsService, PeopleService, MembershipsService],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        people: PeopleService,
        memberships: MembershipsService,
      ) => new AttendanceService(requireDatabase(db), { clubs, people, memberships }),
    },
  ],
  exports: [ActivitiesService, AttendanceService],
})
export class ActivitiesModule {}
