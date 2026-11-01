// SPDX-License-Identifier: AGPL-3.0-only
import { Global, Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { PENDING_DELETION } from "../../platform/domain/pending-deletion.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "../../platform/infra/object-storage.ts";
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
import { DataExportsService } from "./data-exports.service.ts";
import { DataRightsController } from "./data-rights.controller.ts";
import { ErasureService } from "./erasure.service.ts";
import { LeavingController } from "./leaving.controller.ts";
import { LeavingService } from "./leaving.service.ts";
import {
  OUTSTANDING_OBLIGATIONS,
  type OutstandingObligationsProvider,
} from "./outstanding-obligations.ts";

// Global for PENDING_DELETION only (GET /me in the identity module, P1.8b).
@Global()
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
  controllers: [ConsentsController, ClubPrivacyController, LeavingController, DataRightsController],
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
      provide: DataExportsService,
      inject: [DATABASE, OBJECT_STORAGE],
      useFactory: (db: OptionalDatabase, storage: OptionalObjectStorage) =>
        new DataExportsService(requireDatabase(db), { storage: storage ?? null }),
    },
    {
      provide: ErasureService,
      inject: [DATABASE, API_CONFIG, OUTSTANDING_OBLIGATIONS],
      useFactory: (
        db: OptionalDatabase,
        config: ApiConfig,
        obligations: OutstandingObligationsProvider[],
      ) =>
        new ErasureService(requireDatabase(db), {
          graceDays: config.ERASURE_GRACE_DAYS,
          obligations,
        }),
    },
    { provide: PENDING_DELETION, useExisting: ErasureService },
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
  exports: [
    ConsentsService,
    ClubPrivacyService,
    LeavingService,
    DataExportsService,
    ErasureService,
    OUTSTANDING_OBLIGATIONS,
    PENDING_DELETION,
  ],
})
export class PrivacyModule {}
