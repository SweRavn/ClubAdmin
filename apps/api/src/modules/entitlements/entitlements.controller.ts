// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ClubAccessStateRequest,
  ClubAccessStateRequestSchema,
  ClubAccessStateResponseSchema,
  ClubParamsSchema,
  type EntitlementsResponse,
  EntitlementsResponseSchema,
} from "@clubadmin/shared";
import { Body, Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
} from "../authorization/index.ts";
import { operatorTenant } from "../authorization/index.ts";
import { ClubsService } from "../clubs/index.ts";
import { EntitlementsService } from "./entitlements.service.ts";

@Controller("clubs")
export class EntitlementsController {
  private readonly entitlements: EntitlementsService;
  private readonly clubs: ClubsService;

  constructor(entitlements: EntitlementsService, clubs: ClubsService) {
    this.entitlements = entitlements;
    this.clubs = clubs;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/entitlements",
    summary: "What the club may use (features and limits), its plan and access state",
    tags: ["clubs"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: EntitlementsResponseSchema,
    // Clients need to know why a club is restricted.
    clubAccess: "exempt",
  })
  get(@CurrentAuthorization() authorization: RequestAuthorization): Promise<EntitlementsResponse> {
    return this.entitlements.response(resourceOf(authorization, "club").clubId);
  }

  @Endpoint({
    method: "PUT",
    path: ":clubId/access-state",
    summary:
      "Set the club's access state (operators): read_only refuses changes, suspended everything but exports; nothing is deleted",
    tags: ["clubs", "ops"],
    access: { permission: "club.access_state.update", resource: "club" },
    request: { params: ClubParamsSchema, body: ClubAccessStateRequestSchema },
    response: ClubAccessStateResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async setAccessState(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: ClubAccessStateRequest,
  ): Promise<{ clubId: string; accessState: string }> {
    const { clubId } = resourceOf(authorization, "club");
    await this.clubs.setAccessState(
      operatorTenant(authorization.context, clubId),
      body.accessState,
    );
    await this.entitlements.invalidate(clubId);
    return { clubId, accessState: body.accessState };
  }
}
