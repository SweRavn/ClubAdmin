// SPDX-License-Identifier: AGPL-3.0-only
// Person profiles as a viewer sees them (GET /people/:personId): combines the
// person, their club profile and guardians, filtered per relationship.
import { Module } from "@nestjs/common";

import { AuthorizationModule } from "../authorization/index.ts";
import { GuardianshipsModule } from "../guardianships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { PrivacyModule } from "../privacy/index.ts";
import { ProtectionModule } from "../protection/index.ts";
import { PersonProfilesController } from "./person-profiles.controller.ts";

@Module({
  imports: [
    AuthorizationModule,
    GuardianshipsModule,
    PeopleModule,
    PrivacyModule,
    ProtectionModule,
  ],
  controllers: [PersonProfilesController],
})
export class PersonProfilesModule {}
