// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import { AuthorizationModule, PersonPresenter } from "../authorization/index.ts";
import { ClubProfilesModule, ClubProfilesService } from "../club-profiles/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { ProtectionController } from "./protection.controller.ts";
import { ProtectionService } from "./protection.service.ts";

@Module({
  imports: [AccountsModule, AuthorizationModule, ClubProfilesModule, PeopleModule],
  controllers: [ProtectionController],
  providers: [
    {
      provide: ProtectionService,
      inject: [DATABASE, PeopleService, ClubProfilesService, AccountsService, PersonPresenter],
      useFactory: (
        db: OptionalDatabase,
        people: PeopleService,
        profiles: ClubProfilesService,
        accounts: AccountsService,
        presenter: PersonPresenter,
      ) => new ProtectionService(requireDatabase(db), { people, profiles, accounts, presenter }),
    },
  ],
  exports: [ProtectionService],
})
export class ProtectionModule {}
