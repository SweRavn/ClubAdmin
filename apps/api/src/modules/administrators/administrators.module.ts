// SPDX-License-Identifier: AGPL-3.0-only
// At least two administrators; suspending one (P1.15 A3). SessionsService
// comes from the (global) identity module.
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { PeopleModule } from "../people/index.ts";
import { AdministratorsController } from "./administrators.controller.ts";
import { AdministratorsService } from "./administrators.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule],
  controllers: [AdministratorsController],
  providers: [
    {
      provide: AdministratorsService,
      inject: [DATABASE],
      useFactory: (db: OptionalDatabase) => new AdministratorsService(requireDatabase(db)),
    },
  ],
  exports: [AdministratorsService],
})
export class AdministratorsModule {}
