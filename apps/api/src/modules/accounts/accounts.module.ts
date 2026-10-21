// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { AccountsService } from "./accounts.service.ts";

@Module({
  imports: [PeopleModule, MembershipsModule, ClubsModule],
  providers: [
    {
      provide: AccountsService,
      inject: [DATABASE, API_CONFIG, PeopleService, MembershipsService, ClubsService],
      useFactory: (
        db: OptionalDatabase,
        config: ApiConfig,
        people: PeopleService,
        memberships: MembershipsService,
        clubs: ClubsService,
      ) =>
        new AccountsService(requireDatabase(db), {
          people,
          memberships,
          clubs,
          defaultCountry: config.DEFAULT_COUNTRY,
        }),
    },
  ],
  exports: [AccountsService],
})
export class AccountsModule {}
