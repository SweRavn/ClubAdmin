// SPDX-License-Identifier: AGPL-3.0-only
import { ClubParamsSchema, type ClubResponse, ClubSchema } from "@clubadmin/shared";
import { Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { type Club, ClubsService } from "./clubs.service.ts";

export function toClubResponse(club: Club): ClubResponse {
  return {
    id: club.id,
    name: club.name,
    shortName: club.shortName,
    slug: club.slug,
    country: club.country,
    logo: club.logo,
    defaultLocale: club.defaultLocale,
    timeZone: club.timeZone,
    currency: club.currency,
    status: club.status,
    joinPolicy: club.joinPolicy,
  };
}

@Controller("clubs")
export class ClubsController {
  private readonly clubs: ClubsService;

  constructor(clubs: ClubsService) {
    this.clubs = clubs;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId",
    summary: "A club the caller is related to",
    tags: ["clubs"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ClubSchema,
  })
  async getClub(@CurrentAuthorization() authz: RequestAuthorization): Promise<ClubResponse> {
    const { clubId } = resourceOf(authz, "club");
    return toClubResponse(await this.clubs.getClub(tenantContext(authz, clubId)));
  }
}
