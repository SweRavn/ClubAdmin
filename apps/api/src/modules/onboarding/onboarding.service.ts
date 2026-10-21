// SPDX-License-Identifier: AGPL-3.0-only
// Creating a club (ADR 0018): the club, its creator as active member (member
// number 1) and as first club manager, in one transaction. Lives outside the
// clubs module because it combines clubs, memberships and roles.
// Whether the actor may create clubs (CLUB_CREATION) is checked by the
// authorization layer (P0.7) and the sign-up flow (P1.1).

import type { ActorContext, Database, TenantContext } from "@clubadmin/db";
import { type CreateClubInput, uuidv7 } from "@clubadmin/shared";

import { actorPersonId } from "../../platform/domain/run.ts";
import type { Club, ClubsService } from "../clubs/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { RolesService } from "../roles/index.ts";

export class OnboardingService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly memberships: MembershipsService;
  private readonly roles: RolesService;

  constructor(
    db: Database,
    deps: { clubs: ClubsService; memberships: MembershipsService; roles: RolesService },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.memberships = deps.memberships;
    this.roles = deps.roles;
  }

  createClub(context: ActorContext, input: CreateClubInput): Promise<Club> {
    const creator = actorPersonId(context);
    const clubContext: TenantContext = { ...context, clubId: uuidv7() };
    return this.db.withTenant(clubContext, async (tx) => {
      const club = await this.clubs.insertClubInTx(tx, clubContext.clubId, input);
      await this.memberships.addMemberInTx(tx, clubContext, creator);
      await this.roles.assignRoleInTx(tx, clubContext, creator, "club_manager");
      return club;
    });
  }
}
