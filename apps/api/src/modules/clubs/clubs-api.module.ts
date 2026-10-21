// SPDX-License-Identifier: AGPL-3.0-only
// The clubs read endpoint lives in its own module: the club overview lists
// the managers (roles module), and the roles module depends on ClubsModule.
import { Module } from "@nestjs/common";

import { AuthorizationModule } from "../authorization/index.ts";
import { PeopleModule } from "../people/index.ts";
import { RolesModule } from "../roles/index.ts";
import { ClubsController } from "./clubs.controller.ts";
import { ClubsModule } from "./clubs.module.ts";

@Module({
  imports: [ClubsModule, RolesModule, PeopleModule, AuthorizationModule],
  controllers: [ClubsController],
})
export class ClubsApiModule {}
