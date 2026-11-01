// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { EventsModule, EventsService } from "../events/index.ts";
import { GroupsModule, GroupsService } from "../groups/index.ts";
import { JoiningModule, JoinRequestsService } from "../joining/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { RolesModule, RolesService } from "../roles/index.ts";
import { ClubPrivacyController } from "./club-privacy.controller.ts";
import { ClubPrivacyService } from "./club-privacy.service.ts";
import { ConsentsController } from "./consents.controller.ts";
import { ConsentsService } from "./consents.service.ts";
import { LeavingController } from "./leaving.controller.ts";
import { LeavingService } from "./leaving.service.ts";
import {
  OUTSTANDING_OBLIGATIONS,
  type OutstandingObligationsProvider,
} from "./outstanding-obligations.ts";

@Module({
  imports: [
    AuthorizationModule,
    ClubsModule,
    EventsModule,
    GroupsModule,
    JoiningModule,
    MembershipsModule,
    PeopleModule,
    RolesModule,
  ],
  controllers: [ConsentsController, ClubPrivacyController, LeavingController],
  providers: [
    // Modules that issue invoices to members register a provider here (finance, Phase 3).
    { provide: OUTSTANDING_OBLIGATIONS, useValue: [] satisfies OutstandingObligationsProvider[] },
    {
      provide: ConsentsService,
      inject: [DATABASE, ClubsService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService) =>
        new ConsentsService(requireDatabase(db), { clubs }),
    },
    {
      provide: ClubPrivacyService,
      inject: [DATABASE, ClubsService],
      useFactory: (db: OptionalDatabase, clubs: ClubsService) =>
        new ClubPrivacyService(requireDatabase(db), { clubs }),
    },
    {
      provide: LeavingService,
      inject: [
        DATABASE,
        ClubsService,
        RolesService,
        GroupsService,
        MembershipsService,
        JoinRequestsService,
        EventsService,
        ConsentsService,
        OUTSTANDING_OBLIGATIONS,
      ],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        roles: RolesService,
        groups: GroupsService,
        memberships: MembershipsService,
        joinRequests: JoinRequestsService,
        events: EventsService,
        consents: ConsentsService,
        obligations: OutstandingObligationsProvider[],
      ) =>
        new LeavingService(requireDatabase(db), {
          clubs,
          roles,
          groups,
          memberships,
          joinRequests,
          events,
          consents,
          obligations,
        }),
    },
  ],
  exports: [ConsentsService, ClubPrivacyService, LeavingService],
})
export class PrivacyModule {}
