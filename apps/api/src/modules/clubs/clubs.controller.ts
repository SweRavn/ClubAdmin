// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ClubDetail,
  ClubDetailSchema,
  ClubParamsSchema,
  type SetClubPhoneNumbersInput,
  SetClubPhoneNumbersSchema,
  type UpdateClubSettingsInput,
  UpdateClubSettingsSchema,
} from "@clubadmin/shared";
import { Body, Controller } from "@nestjs/common";

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
import { toClubResponse } from "./club-response.ts";
import { type Club, type ClubPhoneNumber, ClubsService } from "./clubs.service.ts";

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
    return this.detail(authz, clubId);
  }

  @Endpoint({
    method: "PATCH",
    path: ":clubId/settings",
    summary:
      "Change the club's settings: time zone, contact details, organisation number, language (P1.6b)",
    tags: ["clubs"],
    access: { permission: "club.settings.update", resource: "club" },
    request: { params: ClubParamsSchema, body: UpdateClubSettingsSchema },
    response: ClubDetailSchema,
  })
  async updateSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: UpdateClubSettingsInput,
  ): Promise<ClubDetail> {
    const { clubId } = resourceOf(authz, "club");
    await this.clubs.updateSettings(tenantContext(authz, clubId), body);
    return this.detail(authz, clubId);
  }

  @Endpoint({
    method: "PUT",
    path: ":clubId/phone-numbers",
    summary: "Set the club's phone numbers (the whole list, in the order shown)",
    tags: ["clubs"],
    access: { permission: "club.settings.update", resource: "club" },
    request: { params: ClubParamsSchema, body: SetClubPhoneNumbersSchema },
    response: ClubDetailSchema,
  })
  async setPhoneNumbers(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: SetClubPhoneNumbersInput,
  ): Promise<ClubDetail> {
    const { clubId } = resourceOf(authz, "club");
    await this.clubs.setPhoneNumbers(tenantContext(authz, clubId), body);
    return this.detail(authz, clubId);
  }

  private async detail(authz: RequestAuthorization, clubId: string): Promise<ClubDetail> {
    const context = tenantContext(authz, clubId);
    // One connection per call: the reads run one after the other.
    const club = await this.clubs.getClub(context);
    const managerIds = await this.roles.activeHolders(context, "club_manager");
    const phoneNumbers = await this.clubs.phoneNumbers(context);
    const managers = await this.presenter.present(
      authz,
      clubId,
      await this.people.summaries(context, managerIds),
    );
    return { ...toClubResponse(club), managers, ...contactOf(club, phoneNumbers) };
  }
}

/** Contact details of the club (P1.6b): for people related to the club. */
function contactOf(club: Club, phoneNumbers: readonly ClubPhoneNumber[]) {
  return {
    email: club.email,
    organizationNumber: club.organizationNumber,
    address: club.address ?? null,
    phoneNumbers: phoneNumbers.map((p) => ({ id: p.id, label: p.label, number: p.number })),
  };
}
