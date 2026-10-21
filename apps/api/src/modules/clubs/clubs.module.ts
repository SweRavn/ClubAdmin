// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubsService } from "./clubs.service.ts";

@Module({
  providers: [
    {
      provide: ClubsService,
      inject: [DATABASE],
      useFactory: (db: OptionalDatabase) => new ClubsService(requireDatabase(db)),
    },
  ],
  exports: [ClubsService],
})
export class ClubsModule {}
