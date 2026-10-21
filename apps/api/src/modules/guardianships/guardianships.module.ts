// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { GuardianshipsService } from "./guardianships.service.ts";

@Module({
  imports: [PeopleModule],
  providers: [
    {
      provide: GuardianshipsService,
      inject: [DATABASE, PeopleService],
      useFactory: (db: OptionalDatabase, people: PeopleService) =>
        new GuardianshipsService(requireDatabase(db), people),
    },
  ],
  exports: [GuardianshipsService],
})
export class GuardianshipsModule {}
