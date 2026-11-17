// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { CarpoolsModule, CarpoolsService } from "../carpools/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { EntitlementsService } from "../entitlements/index.ts";
import { PeopleModule } from "../people/index.ts";
import { ExpensesController } from "./expenses.controller.ts";
import { ExpensesService } from "./expenses.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule, ClubsModule, CarpoolsModule],
  controllers: [ExpensesController],
  providers: [
    {
      provide: ExpensesService,
      inject: [DATABASE, CarpoolsService, ClubsService, EntitlementsService],
      useFactory: (
        db: OptionalDatabase,
        carpools: CarpoolsService,
        clubs: ClubsService,
        entitlements: EntitlementsService,
      ) => new ExpensesService(requireDatabase(db), { carpools, clubs, entitlements }),
    },
  ],
  exports: [ExpensesService],
})
export class ExpensesModule {}
