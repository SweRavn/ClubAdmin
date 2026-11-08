// SPDX-License-Identifier: AGPL-3.0-only
// Loaded only with BILLING_ENABLED=true (EntitlementsModule.register).
import { billingSeller } from "@clubadmin/server-kit";
import { paymentProvider } from "@clubadmin/server-kit/payments";
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import type { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import { ENTITLEMENTS_CACHE } from "../../platform/entitlements/entitlements.tokens.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "../../platform/infra/object-storage.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { BillingController } from "./billing.controller.ts";
import { BillingService } from "./billing.service.ts";
import { BillingOpsController } from "./billing-ops.controller.ts";
import { BillingWebhookController } from "./billing-webhook.controller.ts";
import { PlanEntitlements } from "./plan-entitlements.ts";

@Module({
  imports: [ClubsModule, AuthorizationModule],
  controllers: [BillingController, BillingOpsController, BillingWebhookController],
  providers: [
    {
      provide: PlanEntitlements,
      inject: [API_CONFIG, DATABASE],
      useFactory: (c: ApiConfig, db: OptionalDatabase) =>
        new PlanEntitlements(requireDatabase(db), c.BILLING_DEFAULT_PLAN),
    },
    {
      provide: BillingService,
      inject: [DATABASE, ClubsService, ENTITLEMENTS_CACHE, API_CONFIG, OBJECT_STORAGE],
      useFactory: (
        db: OptionalDatabase,
        clubs: ClubsService,
        cache: EntitlementsCache<unknown>,
        c: ApiConfig,
        storage: OptionalObjectStorage,
      ) => {
        const seller = billingSeller(c);
        return new BillingService(requireDatabase(db), {
          clubs,
          cache,
          options: seller
            ? {
                settings: {
                  seller,
                  invoicePrefix: c.BILLING_INVOICE_PREFIX,
                  paymentTermsDays: c.BILLING_PAYMENT_TERMS_DAYS,
                  defaultPlan: c.BILLING_DEFAULT_PLAN,
                },
                storage,
                termsVersion: c.BILLING_TERMS_VERSION,
                termsUrl: c.BILLING_TERMS_URL ?? null,
                payments: paymentProvider(c),
                webUrl: c.PUBLIC_WEB_URL,
              }
            : null,
        });
      },
    },
  ],
  exports: [PlanEntitlements, BillingService],
})
export class BillingModule {}
