// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { PeopleModule } from "../people/index.ts";
import { NotificationsController, UnsubscribeController } from "./notifications.controller.ts";
import { NotificationsService } from "./notifications.service.ts";

@Module({
  imports: [AuthorizationModule, PeopleModule],
  controllers: [NotificationsController, UnsubscribeController],
  providers: [
    {
      provide: NotificationsService,
      inject: [DATABASE, API_CONFIG],
      useFactory: (db: OptionalDatabase, config: ApiConfig) =>
        new NotificationsService(requireDatabase(db), {
          tokenKey: config.NOTIFICATION_TOKEN_KEY,
          push: config.PUSH_PROVIDER !== undefined,
        }),
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
