// SPDX-License-Identifier: AGPL-3.0-only
// Loaded only with BILLING_ENABLED=true (EntitlementsModule.register).
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import type { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import { ENTITLEMENTS_CACHE } from "../../platform/entitlements/entitlements.tokens.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { BillingController } from "./billing.controller.ts";
import { BillingService } from "./billing.service.ts";
import { PlanEntitlements } from "./plan-entitlements.ts";

@Module({
  imports: [ClubsModule, AuthorizationModule],
  controllers: [BillingController],
  providers: [
    {
      provide: PlanEntitlements,
      inject: [API_CONFIG, DATABASE],
      useFactory: (c: ApiConfig, db: OptionalDatabase) =>
        new PlanEntitlements(requireDatabase(db), c.BILLING_DEFAULT_PLAN),
    },
    {
      provide: BillingService,
      inject: [DATABASE, ClubsService, ENTITLEMENTS_CACHE],
      useFactory: (db: OptionalDatabase, clubs: ClubsService, cache: EntitlementsCache<unknown>) =>
        new BillingService(requireDatabase(db), { clubs, cache }),
    },
  ],
  exports: [PlanEntitlements, BillingService],
})
export class BillingModule {}
