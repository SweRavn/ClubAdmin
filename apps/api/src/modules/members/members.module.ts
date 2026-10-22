// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "../../platform/infra/object-storage.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { MembershipsModule } from "../memberships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { MemberExportsController } from "./member-exports.controller.ts";
import { MembersController } from "./members.controller.ts";
import { MembersService } from "./members.service.ts";

@Module({
  imports: [AuthorizationModule, MembershipsModule, PeopleModule],
  controllers: [MembersController, MemberExportsController],
  providers: [
    {
      provide: MembersService,
      inject: [DATABASE, OBJECT_STORAGE, API_CONFIG],
      useFactory: (db: OptionalDatabase, storage: OptionalObjectStorage, config: ApiConfig) =>
        new MembersService(requireDatabase(db), storage, {
          exportsPerPersonPerDay: config.MEMBER_EXPORTS_PER_PERSON_DAY,
          exportsPerClubPerDay: config.MEMBER_EXPORTS_PER_CLUB_DAY,
        }),
    },
  ],
  exports: [MembersService],
})
export class MembersModule {}
