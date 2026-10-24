// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { FIELD_ENCRYPTION, type FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ActivitiesModule, ActivitiesService, AttendanceService } from "../activities/index.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { PeopleModule } from "../people/index.ts";
import { EventsController } from "./events.controller.ts";
import { EventsService } from "./events.service.ts";

@Module({
  imports: [AuthorizationModule, ActivitiesModule, ClubsModule, PeopleModule],
  controllers: [EventsController],
  providers: [
    {
      provide: EventsService,
      inject: [DATABASE, ClubsService, ActivitiesService, AttendanceService, FIELD_ENCRYPTION],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        activities: ActivitiesService,
        attendance: AttendanceService,
        encryption: FieldEncryption,
      ) => new EventsService(requireDatabase(db), { clubs, activities, attendance, encryption }),
    },
  ],
  exports: [EventsService],
})
export class EventsModule {}
