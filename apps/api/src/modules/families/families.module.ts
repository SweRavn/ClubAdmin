// SPDX-License-Identifier: AGPL-3.0-only
// The family endpoints (P1.3): the guardianships, person-merge and accounts
// services do the work; the controllers add authorization and presenters.
import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/index.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { GuardianshipsModule } from "../guardianships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { PersonMergeModule } from "../person-merge/index.ts";
import { ClubGuardiansController } from "./club-guardians.controller.ts";
import { FamilyController } from "./family.controller.ts";
import { PeopleFamilyController } from "./people-family.controller.ts";

@Module({
  imports: [
    AuthorizationModule,
    GuardianshipsModule,
    PersonMergeModule,
    AccountsModule,
    PeopleModule,
  ],
  controllers: [FamilyController, PeopleFamilyController, ClubGuardiansController],
})
export class FamiliesModule {}
