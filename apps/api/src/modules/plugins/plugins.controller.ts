// SPDX-License-Identifier: AGPL-3.0-only
// Plugins (P2.7, ADR 0051): the installation's plugins for operators, a
// club's plugins (enable, configure, set secrets, with a second factor),
// and the background-check types and requirements of its enabled plugins.

import { negotiateLocale } from "@clubadmin/i18n";
import {
  type BackgroundCheckTypes,
  BackgroundCheckTypesSchema,
  ClubParamsSchema,
  type ClubPluginList,
  ClubPluginListSchema,
  ClubPluginParamsSchema,
  type InstalledPluginList,
  InstalledPluginListSchema,
  type PutClubPluginInput,
  PutClubPluginSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { PluginsService } from "./plugins.service.ts";

const TAGS = ["plugins"];

@Controller()
export class PluginsController {
  private readonly plugins: PluginsService;

  constructor(plugins: PluginsService) {
    this.plugins = plugins;
  }

  @Endpoint({
    method: "GET",
    path: "ops/plugins",
    summary: "The installation's plugins, their versions and what they need (operators)",
    tags: [...TAGS, "ops"],
    access: { permission: "ops.plugins.manage", resource: "platform" },
    response: InstalledPluginListSchema,
  })
  installed(): InstalledPluginList {
    return this.plugins.installed();
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/plugins",
    summary: "The plugins for the club's country and the club's settings (secrets by name only)",
    tags: TAGS,
    access: { permission: "club.plugins.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ClubPluginListSchema,
  })
  async clubPlugins(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Req() request: FastifyRequest,
  ): Promise<ClubPluginList> {
    const locale = negotiateLocale(request.headers["accept-language"]);
    return { items: await this.plugins.clubPlugins(tenantContext(authz, params.clubId), locale) };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/plugins/:pluginId",
    summary: "Enable, disable or configure a plugin for the club",
    tags: TAGS,
    access: { permission: "club.plugins.manage", resource: "club" },
    request: { params: ClubPluginParamsSchema, body: PutClubPluginSchema },
    response: z.null(),
    status: 204,
  })
  async putClubPlugin(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; pluginId: string },
    @Body() body: PutClubPluginInput,
  ): Promise<null> {
    await this.plugins.putClubPlugin(tenantContext(authz, params.clubId), params.pluginId, body);
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/background-checks/types",
    summary: "Background-check types and requirements from the club's enabled plugins",
    tags: TAGS,
    access: { permission: "club.background_checks.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: BackgroundCheckTypesSchema,
  })
  backgroundCheckTypes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Req() request: FastifyRequest,
  ): Promise<BackgroundCheckTypes> {
    const locale = negotiateLocale(request.headers["accept-language"]);
    return this.plugins.backgroundCheckTypes(tenantContext(authz, params.clubId), locale);
  }
}
