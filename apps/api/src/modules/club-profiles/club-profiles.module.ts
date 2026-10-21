// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubProfilesService } from "./club-profiles.service.ts";

@Module({
  providers: [
    {
      provide: ClubProfilesService,
      inject: [DATABASE],
      useFactory: (db: OptionalDatabase) => new ClubProfilesService(requireDatabase(db)),
    },
  ],
  exports: [ClubProfilesService],
})
export class ClubProfilesModule {}
