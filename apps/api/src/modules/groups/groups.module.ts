// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { PeopleModule } from "../people/index.ts";
import { GroupsController } from "./groups.controller.ts";
import { GroupsService } from "./groups.service.ts";

@Module({
  imports: [ClubsModule, AuthorizationModule, PeopleModule],
  controllers: [GroupsController],
  providers: [
    {
      provide: GroupsService,
      inject: [DATABASE, ClubsService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService) =>
        new GroupsService(requireDatabase(db), clubs),
    },
  ],
  exports: [GroupsService],
})
export class GroupsModule {}
