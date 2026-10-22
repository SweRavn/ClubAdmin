// SPDX-License-Identifier: AGPL-3.0-only
// Entitlements are always present; the billing module (and with it the plan
// based entitlement source and the billing routes) only with
// BILLING_ENABLED=true (docs/hosting-and-billing.md).
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import {
  enabledFeatures,
  ENTITLEMENT_SOURCE,
  type EntitlementSource,
  FlagsEntitlements,
} from "../../platform/entitlements/entitlements.source.ts";
import { ENTITLEMENTS_CACHE } from "../../platform/entitlements/entitlements.tokens.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { BillingModule } from "../billing/index.ts";
import { PlanEntitlements } from "../billing/index.ts";
import { ClubsModule } from "../clubs/index.ts";
import { EntitlementsController } from "./entitlements.controller.ts";
import { type ClubEntitlements, EntitlementsService } from "./entitlements.service.ts";

/** The cache, shared by the entitlements service and the billing module (which invalidates it). */
@Global()
@Module({
  providers: [
    {
      provide: ENTITLEMENTS_CACHE,
      inject: [VALKEY_CLIENT],
      useFactory: (valkey: ValkeyClient) => new EntitlementsCache<ClubEntitlements>(valkey),
    },
  ],
  exports: [ENTITLEMENTS_CACHE],
})
export class EntitlementsCacheModule implements OnModuleInit, OnApplicationShutdown {
  private readonly cache: EntitlementsCache<ClubEntitlements>;

  constructor(@Inject(ENTITLEMENTS_CACHE) cache: EntitlementsCache<ClubEntitlements>) {
    this.cache = cache;
  }

  onModuleInit(): Promise<void> {
    return this.cache.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.cache.stop();
  }
}

@Module({})
export class EntitlementsModule {
  static register(config: Pick<ApiConfig, "BILLING_ENABLED">): DynamicModule {
    const billing = config.BILLING_ENABLED;
    return {
      module: EntitlementsModule,
      global: true,
      imports: [
        EntitlementsCacheModule,
        ClubsModule,
        AuthorizationModule,
        ...(billing ? [BillingModule] : []),
      ],
      controllers: [EntitlementsController],
      providers: [
        billing
          ? { provide: ENTITLEMENT_SOURCE, useExisting: PlanEntitlements }
          : {
              provide: ENTITLEMENT_SOURCE,
              inject: [API_CONFIG],
              useFactory: (c: ApiConfig) => new FlagsEntitlements(enabledFeatures(c)),
            },
        {
          provide: EntitlementsService,
          inject: [API_CONFIG, DATABASE, ENTITLEMENT_SOURCE, ENTITLEMENTS_CACHE],
          useFactory: (
            c: ApiConfig,
            db: OptionalDatabase,
            source: EntitlementSource,
            cache: EntitlementsCache<ClubEntitlements>,
          ) =>
            new EntitlementsService(requireDatabase(db), source, cache, {
              enabled: enabledFeatures(c),
              billingEnabled: c.BILLING_ENABLED,
            }),
        },
      ],
      exports: [EntitlementsService],
    };
  }
}
