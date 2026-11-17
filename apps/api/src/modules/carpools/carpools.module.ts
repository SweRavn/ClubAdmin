// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { GuardianshipsModule, GuardianshipsService } from "../guardianships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { CarpoolsController } from "./carpools.controller.ts";
import { CarpoolsService } from "./carpools.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule, GuardianshipsModule],
  controllers: [CarpoolsController],
  providers: [
    {
      provide: CarpoolsService,
      inject: [DATABASE, GuardianshipsService],
      useFactory: (db: OptionalDatabase, guardianships: GuardianshipsService) =>
        new CarpoolsService(requireDatabase(db), { guardianships }),
    },
  ],
  exports: [CarpoolsService],
})
export class CarpoolsModule {}
