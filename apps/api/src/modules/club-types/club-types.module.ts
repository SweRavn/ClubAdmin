// SPDX-License-Identifier: AGPL-3.0-only
// Club types and their templates (P1.15 B).
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubTypesController } from "./club-types.controller.ts";
import { ClubTypesService } from "./club-types.service.ts";

@Module({
  imports: [AuthorizationModule],
  controllers: [ClubTypesController],
  providers: [
    {
      provide: ClubTypesService,
      inject: [DATABASE],
      useFactory: (db: OptionalDatabase) => new ClubTypesService(requireDatabase(db)),
    },
  ],
  exports: [ClubTypesService],
})
export class ClubTypesModule {}
