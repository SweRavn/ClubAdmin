// SPDX-License-Identifier: AGPL-3.0-only
// Club-defined roles (P1.15 A2): the roles API next to the roles module (it
// presents people, so it needs the authorization and people modules, which
// the roles module itself must not depend on).
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { PeopleModule } from "../people/index.ts";
import { ClubRolesController } from "./club-roles.controller.ts";
import { ClubRolesService } from "./club-roles.service.ts";
import { RolesModule } from "./roles.module.ts";
import { RolesService } from "./roles.service.ts";

@Module({
  imports: [AuthorizationModule, ClubsModule, PeopleModule, RolesModule],
  controllers: [ClubRolesController],
  providers: [
    {
      provide: ClubRolesService,
      inject: [DATABASE, ClubsService, RolesService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService, roles: RolesService) =>
        new ClubRolesService(requireDatabase(db), clubs, roles),
    },
  ],
  exports: [ClubRolesService],
})
export class ClubRolesModule {}
