// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ClubDetail,
  ClubDetailSchema,
  ClubParamsSchema,
  type ClubResponse,
} from "@clubadmin/shared";
import { Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { RolesService } from "../roles/index.ts";
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
  private readonly roles: RolesService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    clubs: ClubsService,
    roles: RolesService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.clubs = clubs;
    this.roles = roles;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId",
    summary: "A club the caller is related to, with its managers",
    tags: ["clubs"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ClubDetailSchema,
  })
  async getClub(@CurrentAuthorization() authz: RequestAuthorization): Promise<ClubDetail> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const [club, managerIds] = await Promise.all([
      this.clubs.getClub(context),
      this.roles.activeHolders(context, "club_manager"),
    ]);
    const managers = await this.presenter.present(
      authz,
      clubId,
      await this.people.summaries(context, managerIds),
    );
    return { ...toClubResponse(club), managers };
  }
}
