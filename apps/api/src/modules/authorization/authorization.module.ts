// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig, clubCreationMode } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AuthorizationService } from "./authorization.service.ts";
import { AuthorizationCache } from "./authorization-cache.ts";
import { PersonVisibility } from "./person-visibility.service.ts";
import { FamilyPresenter } from "./presenters/family.presenter.ts";
import { PersonPresenter } from "./presenters/person.presenter.ts";
import { PersonProfilePresenter } from "./presenters/person-profile.presenter.ts";
import { RegisterPresenter } from "./presenters/register.presenter.ts";

@Module({
  providers: [
    {
      provide: AuthorizationCache,
      inject: [VALKEY_CLIENT],
      useFactory: (valkey: ValkeyClient) => new AuthorizationCache(valkey),
    },
    {
      provide: AuthorizationService,
      inject: [DATABASE, AuthorizationCache, API_CONFIG],
      useFactory: (db: OptionalDatabase, cache: AuthorizationCache, config: ApiConfig) =>
        new AuthorizationService(requireDatabase(db), cache, {
          clubCreation: clubCreationMode(config),
        }),
    },
    {
      provide: PersonVisibility,
      inject: [DATABASE, AuthorizationCache],
      useFactory: (db: OptionalDatabase, cache: AuthorizationCache) =>
        new PersonVisibility(requireDatabase(db), cache),
    },
    {
      provide: PersonPresenter,
      inject: [PersonVisibility],
      useFactory: (visibility: PersonVisibility) => new PersonPresenter(visibility),
    },
    {
      provide: PersonProfilePresenter,
      inject: [PersonPresenter],
      useFactory: (people: PersonPresenter) => new PersonProfilePresenter(people),
    },
    {
      provide: FamilyPresenter,
      inject: [PersonPresenter],
      useFactory: (people: PersonPresenter) => new FamilyPresenter(people),
    },
    {
      provide: RegisterPresenter,
      inject: [PersonPresenter],
      useFactory: (people: PersonPresenter) => new RegisterPresenter(people),
    },
  ],
  exports: [
    AuthorizationService,
    PersonVisibility,
    PersonPresenter,
    PersonProfilePresenter,
    RegisterPresenter,
    FamilyPresenter,
  ],
})
export class AuthorizationModule {}
