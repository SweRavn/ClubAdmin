// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { GuardianshipsService } from "./guardianships.service.ts";

@Module({
  imports: [PeopleModule, AccountsModule, MembershipsModule],
  providers: [
    {
      provide: GuardianshipsService,
      inject: [DATABASE, API_CONFIG, PeopleService, AccountsService, MembershipsService],
      useFactory: (
        db: OptionalDatabase,
        config: ApiConfig,
        people: PeopleService,
        accounts: AccountsService,
        memberships: MembershipsService,
      ) =>
        new GuardianshipsService(requireDatabase(db), {
          people,
          accounts,
          memberships,
          tokenKey: config.INVITATION_TOKEN_KEY,
        }),
    },
  ],
  exports: [GuardianshipsService],
})
export class GuardianshipsModule {}
