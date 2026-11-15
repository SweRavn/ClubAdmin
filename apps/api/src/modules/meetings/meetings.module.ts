// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { DocumentsModule, GoverningService } from "../documents/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { MeetingsController } from "./meetings.controller.ts";
import { MeetingsService } from "./meetings.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule, ClubsModule, MembershipsModule, DocumentsModule],
  controllers: [MeetingsController],
  providers: [
    {
      provide: MeetingsService,
      inject: [DATABASE, ClubsService, MembershipsService, GoverningService],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        memberships: MembershipsService,
        governing: GoverningService,
      ) => new MeetingsService(requireDatabase(db), { clubs, memberships, governing }),
    },
  ],
  exports: [MeetingsService],
})
export class MeetingsModule {}
