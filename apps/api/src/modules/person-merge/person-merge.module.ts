// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { ClubProfilesModule, ClubProfilesService } from "../club-profiles/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { PersonMergeService } from "./person-merge.service.ts";

@Module({
  imports: [PeopleModule, ClubProfilesModule],
  providers: [
    {
      provide: PersonMergeService,
      inject: [DATABASE, PeopleService, ClubProfilesService],
      useFactory: (db: OptionalDatabase, people: PeopleService, profiles: ClubProfilesService) =>
        new PersonMergeService(requireDatabase(db), { people, profiles }),
    },
  ],
  exports: [PersonMergeService],
})
export class PersonMergeModule {}
