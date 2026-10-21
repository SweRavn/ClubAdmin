// SPDX-License-Identifier: AGPL-3.0-only
import { type DynamicModule, Module, type Type } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";

import { API_CONFIG, type ApiConfig } from "./config.ts";
import { DomainModule } from "./domain.module.ts";
import { IdentityModule } from "./modules/identity/index.ts";
import { HealthController } from "./platform/health/health.controller.ts";
import { EndpointRegistry } from "./platform/http/endpoint-registry.ts";
import { ProblemDetailsFilter } from "./platform/http/problem.filter.ts";
import { ValidationInterceptor } from "./platform/http/validation.interceptor.ts";
import { InfraModule } from "./platform/infra/infra.module.ts";
import { MetaController } from "./platform/meta/meta.controller.ts";
import { OpenApiController } from "./platform/openapi/openapi.controller.ts";

@Module({})
export class AppModule {
  /** Feature modules (apps/api/src/modules/*) are added to `modules` as they are built. */
  static register(config: ApiConfig, extraModules: (Type | DynamicModule)[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DiscoveryModule,
        {
          module: ConfigModule,
          global: true,
          providers: [{ provide: API_CONFIG, useValue: config }],
          exports: [API_CONFIG],
        },
        InfraModule,
        DomainModule,
        IdentityModule.register(config),
        ...extraModules,
      ],
      controllers: [HealthController, MetaController, OpenApiController],
      providers: [
        EndpointRegistry,
        { provide: APP_INTERCEPTOR, useClass: ValidationInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
      exports: [EndpointRegistry],
    };
  }
}

@Module({})
class ConfigModule {}
