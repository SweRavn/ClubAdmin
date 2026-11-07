// SPDX-License-Identifier: AGPL-3.0-only
// Protected identity (P1.12, ADR 0022): the flags, the person's access log
// across clubs, and the club's profile view log and its setting.

import {
  AccessLogQuerySchema,
  ClubParamsSchema,
  type ClubProfileViews,
  type ClubProfileViewsQuery,
  ClubProfileViewsQuerySchema,
  ClubProfileViewsSchema,
  OkSchema,
  PersonParamsSchema,
  type ProfileViewLoggingInput,
  ProfileViewLoggingSchema,
  type ProfileViewPage,
  ProfileViewPageSchema,
  ProtectionQuerySchema,
  type SetProtectionInput,
  SetProtectionSchema,
} from "@clubadmin/shared";
import { Body, Controller, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
} from "../authorization/index.ts";
import { ProtectionService } from "./protection.service.ts";

/** Per account: changing a flag or reading a log is rare (P0.10). */
const WRITE_LIMIT = { max: 30, timeWindowMs: 60_000 };

@Controller()
export class ProtectionController {
  private readonly protection: ProtectionService;

  constructor(protection: ProtectionService) {
    this.protection = protection;
  }

  @Endpoint({
    method: "PUT",
    path: "people/:personId/protection",
    summary:
      "Turn protected identity on or off: globally (the person or a full guardian; off needs a recent login) or with clubId in the club (club managers, second factor)",
    tags: ["people", "protection"],
    access: { permission: "person.protection.set", resource: "person" },
    request: {
      params: PersonParamsSchema,
      query: ProtectionQuerySchema,
      body: SetProtectionSchema,
    },
    response: OkSchema,
    rateLimit: WRITE_LIMIT,
  })
  async set(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: SetProtectionInput,
  ): Promise<{ ok: true }> {
    const person = resourceOf(authz, "person");
    if (person.clubId) {
      await this.protection.setClub(authz, person.clubId, person.personId, body.protected);
    } else {
      await this.protection.setGlobal(authz, person.personId, body.protected);
    }
    return { ok: true };
  }

  @Endpoint({
    method: "GET",
    path: "people/:personId/access-log",
    summary: "Who has opened this profile, in every club (the person and full guardians)",
    tags: ["people", "protection"],
    access: { permission: "person.access_log.read", resource: "person" },
    request: { params: PersonParamsSchema, query: AccessLogQuerySchema },
    response: ProfileViewPageSchema,
    rateLimit: WRITE_LIMIT,
  })
  accessLog(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query("cursor") cursor: string | undefined,
  ): Promise<ProfileViewPage> {
    return this.protection.accessLog(authz, resourceOf(authz, "person").personId, cursor ?? null);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/profile-views",
    summary: "The club's profile view log (club managers, second factor)",
    tags: ["clubs", "protection"],
    access: { permission: "club.profile_views.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ClubProfileViewsQuerySchema },
    response: ClubProfileViewsSchema,
  })
  clubLog(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ClubProfileViewsQuery,
  ): Promise<ClubProfileViews> {
    return this.protection.clubLog(authz, resourceOf(authz, "club").clubId, query);
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/profile-view-logging",
    summary: "Log views of protected members only, or every profile view (club managers)",
    tags: ["clubs", "protection"],
    access: { permission: "club.profile_views.configure", resource: "club" },
    request: { params: ClubParamsSchema, body: ProfileViewLoggingSchema },
    response: OkSchema,
  })
  async setLogging(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: ProfileViewLoggingInput,
  ): Promise<{ ok: true }> {
    await this.protection.setLoggingMode(authz, resourceOf(authz, "club").clubId, body.mode);
    return { ok: true };
  }
}
