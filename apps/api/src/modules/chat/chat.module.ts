// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { BackgroundChecksModule, BackgroundChecksService } from "../background-checks/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { GroupsModule, GroupsService } from "../groups/index.ts";
import { PeopleModule } from "../people/index.ts";
import { RealtimeModule, RealtimePublisher } from "../realtime/index.ts";
import { ChatController } from "./chat.controller.ts";
import { ChatGateway } from "./chat.gateway.ts";
import { ChatService } from "./chat.service.ts";
import { SafeguardingController } from "./safeguarding.controller.ts";
import { SafeguardingService } from "./safeguarding.service.ts";

@Module({
  imports: [
    AuthorizationModule,
    BackgroundChecksModule,
    ClubsModule,
    GroupsModule,
    PeopleModule,
    RealtimeModule,
  ],
  controllers: [ChatController, SafeguardingController],
  providers: [
    {
      provide: ChatService,
      inject: [DATABASE, RealtimePublisher, ClubsService, GroupsService, BackgroundChecksService],
      useFactory: (
        db: OptionalDatabase,
        publisher: RealtimePublisher,
        clubs: ClubsService,
        groups: GroupsService,
        checks: BackgroundChecksService,
      ) => new ChatService(requireDatabase(db), { publisher, clubs, groups, checks }),
    },
    {
      provide: SafeguardingService,
      inject: [DATABASE, RealtimePublisher],
      useFactory: (db: OptionalDatabase, publisher: RealtimePublisher) =>
        new SafeguardingService(requireDatabase(db), { publisher }),
    },
    ChatGateway,
  ],
  exports: [ChatService, SafeguardingService],
})
export class ChatModule {}
