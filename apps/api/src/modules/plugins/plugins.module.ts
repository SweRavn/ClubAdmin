// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { FIELD_ENCRYPTION, type FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { BUNDLED_PLUGINS } from "../../plugins.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { PluginsController } from "./plugins.controller.ts";
import { PLUGIN_REGISTRY, PluginRegistry } from "./plugins.registry.ts";
import { PluginsService } from "./plugins.service.ts";

@Module({
  imports: [AuthorizationModule, ClubsModule],
  controllers: [PluginsController],
  providers: [
    {
      provide: PLUGIN_REGISTRY,
      inject: [API_CONFIG],
      useFactory: (c: ApiConfig) => PluginRegistry.fromConfig(BUNDLED_PLUGINS, c.PLUGINS),
    },
    {
      provide: PluginsService,
      inject: [DATABASE, PLUGIN_REGISTRY, ClubsService, FIELD_ENCRYPTION],
      useFactory: (
        db: OptionalDatabase,
        registry: PluginRegistry,
        clubs: ClubsService,
        encryption: FieldEncryption,
      ) => new PluginsService(requireDatabase(db), { registry, clubs, encryption }),
    },
  ],
  exports: [PluginsService, PLUGIN_REGISTRY],
})
export class PluginsModule {}
