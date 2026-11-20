// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { AccountsService } from "./accounts.service.ts";
import { zitadelEmails as zitadelEmailClient } from "./zitadel-emails.ts";

/** Zitadel's copy of the login email, when the API can reach Zitadel (P2.7d). */
function zitadelEmails(config: ApiConfig) {
  const url = config.ZITADEL_API_URL ?? config.AUTH_ISSUER;
  return url && config.ZITADEL_API_TOKEN
    ? zitadelEmailClient(url, config.ZITADEL_API_TOKEN)
    : undefined;
}

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
          invitationTokenKey: config.INVITATION_TOKEN_KEY,
          identityProvider: zitadelEmails(config),
        }),
    },
  ],
  exports: [AccountsService],
})
export class AccountsModule {}
