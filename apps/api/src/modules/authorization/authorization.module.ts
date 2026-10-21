// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AuthorizationService } from "./authorization.service.ts";
import { AuthorizationCache } from "./authorization-cache.ts";
import { PersonVisibility } from "./person-visibility.service.ts";
import { PersonPresenter } from "./presenters/person.presenter.ts";
import { PersonProfilePresenter } from "./presenters/person-profile.presenter.ts";

@Module({
  providers: [
    {
      provide: AuthorizationCache,
      inject: [VALKEY_CLIENT],
      useFactory: (valkey: ValkeyClient) => new AuthorizationCache(valkey),
    },
    {
      provide: AuthorizationService,
      inject: [DATABASE, AuthorizationCache],
      useFactory: (db: OptionalDatabase, cache: AuthorizationCache) =>
        new AuthorizationService(requireDatabase(db), cache),
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
  ],
  exports: [AuthorizationService, PersonVisibility, PersonPresenter, PersonProfilePresenter],
})
export class AuthorizationModule {}
