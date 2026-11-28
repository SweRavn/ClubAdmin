// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { BackgroundChecksModule, BackgroundChecksService } from "../background-checks/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { PeopleModule } from "../people/index.ts";
import { DutiesController } from "./duties.controller.ts";
import { DutiesService } from "./duties.service.ts";

@Module({
  imports: [AuthorizationModule, BackgroundChecksModule, PeopleModule, ClubsModule],
  controllers: [DutiesController],
  providers: [
    {
      provide: DutiesService,
      inject: [DATABASE, ClubsService, BackgroundChecksService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService, checks: BackgroundChecksService) =>
        new DutiesService(requireDatabase(db), { clubs, checks }),
    },
  ],
  exports: [DutiesService],
})
export class DutiesModule {}
