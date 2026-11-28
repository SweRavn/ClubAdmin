// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ActivitiesModule, ActivitiesService } from "../activities/index.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { CarpoolsModule, CarpoolsService } from "../carpools/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { DutiesModule, DutiesService } from "../duties/index.ts";
import { EventsModule, EventsService } from "../events/index.ts";
import { ProgrammesController } from "./programmes.controller.ts";
import { ProgrammesService } from "./programmes.service.ts";

@Module({
  imports: [
    AuthorizationModule,
    ActivitiesModule,
    CarpoolsModule,
    ClubsModule,
    DutiesModule,
    EventsModule,
  ],
  controllers: [ProgrammesController],
  providers: [
    {
      provide: ProgrammesService,
      inject: [
        DATABASE,
        ClubsService,
        ActivitiesService,
        DutiesService,
        EventsService,
        CarpoolsService,
      ],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        activities: ActivitiesService,
        duties: DutiesService,
        events: EventsService,
        carpools: CarpoolsService,
      ) =>
        new ProgrammesService(requireDatabase(db), { clubs, activities, duties, events, carpools }),
    },
  ],
  exports: [ProgrammesService],
})
export class ProgrammesModule {}
