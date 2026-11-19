// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import {
  PLUGIN_REGISTRY,
  type PluginRegistry,
  PluginsModule,
  PluginsService,
} from "../plugins/index.ts";
import { GrantsController } from "./grants.controller.ts";
import { GrantsService } from "./grants.service.ts";

@Module({
  imports: [AuthorizationModule, ClubsModule, PeopleModule, PluginsModule],
  controllers: [GrantsController],
  providers: [
    {
      provide: GrantsService,
      inject: [DATABASE, PluginsService, PLUGIN_REGISTRY, PeopleService, ClubsService],
      useFactory: (
        db: OptionalDatabase,
        plugins: PluginsService,
        registry: PluginRegistry,
        people: PeopleService,
        clubs: ClubsService,
      ) => new GrantsService(requireDatabase(db), { plugins, registry, people, clubs }),
    },
  ],
  exports: [GrantsService],
})
export class GrantsModule {}
