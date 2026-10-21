// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { RolesService } from "./roles.service.ts";

@Module({
  imports: [ClubsModule],
  providers: [
    {
      provide: RolesService,
      inject: [DATABASE, ClubsService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService) =>
        new RolesService(requireDatabase(db), clubs),
    },
  ],
  exports: [RolesService],
})
export class RolesModule {}
