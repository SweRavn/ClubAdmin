// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { PeopleModule } from "../people/index.ts";
import { AnnouncementsController } from "./announcements.controller.ts";
import { AnnouncementsService } from "./announcements.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule],
  controllers: [AnnouncementsController],
  providers: [
    {
      provide: AnnouncementsService,
      inject: [DATABASE, API_CONFIG],
      useFactory: (db: OptionalDatabase, config: ApiConfig) =>
        new AnnouncementsService(requireDatabase(db), {
          emailsPerClubDay: config.ANNOUNCEMENT_EMAILS_PER_CLUB_DAY,
        }),
    },
  ],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}
