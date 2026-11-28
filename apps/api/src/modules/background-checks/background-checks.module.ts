// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { PeopleModule } from "../people/index.ts";
import {
  PLUGIN_REGISTRY,
  PluginRegistry,
  PluginsModule,
  PluginsService,
} from "../plugins/index.ts";
import { BackgroundChecksController } from "./background-checks.controller.ts";
import { BackgroundChecksService } from "./background-checks.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule, PluginsModule],
  controllers: [BackgroundChecksController],
  providers: [
    {
      provide: BackgroundChecksService,
      inject: [DATABASE, PLUGIN_REGISTRY, PluginsService],
      useFactory: (db: OptionalDatabase, registry: PluginRegistry, plugins: PluginsService) =>
        new BackgroundChecksService(requireDatabase(db), { registry, plugins }),
    },
  ],
  exports: [BackgroundChecksService],
})
export class BackgroundChecksModule {}
