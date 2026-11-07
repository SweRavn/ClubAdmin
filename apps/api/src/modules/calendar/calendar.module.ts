// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { RateLimiter } from "../../platform/http/rate-limiter.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import { ActivitiesModule, ActivitiesService, AttendanceService } from "../activities/index.ts";
import {
  AuthorizationModule,
  AuthorizationService,
  PersonPresenter,
} from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { EntitlementsService } from "../entitlements/index.ts";
import { GroupsModule, GroupsService } from "../groups/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { CalendarController } from "./calendar.controller.ts";
import { CalendarService, type FeedCache } from "./calendar.service.ts";

const valkeyCache = (valkey: ValkeyClient, namespace: string): FeedCache | null =>
  valkey
    ? {
        get: async (key) => {
          try {
            return await valkey.get(`${namespace}:${key}`);
          } catch {
            return null;
          }
        },
        set: async (key, value, seconds) => {
          try {
            await valkey.set(`${namespace}:${key}`, value, "EX", seconds);
          } catch {
            // A cache: without Valkey the feed is rendered each time.
          }
        },
      }
    : null;

@Module({
  imports: [
    AccountsModule,
    ActivitiesModule,
    AuthorizationModule,
    ClubsModule,
    GroupsModule,
    PeopleModule,
  ],
  controllers: [CalendarController],
  providers: [
    {
      provide: CalendarService,
      inject: [
        DATABASE,
        API_CONFIG,
        VALKEY_CLIENT,
        ActivitiesService,
        AttendanceService,
        AuthorizationService,
        PeopleService,
        PersonPresenter,
        EntitlementsService,
        ClubsService,
        GroupsService,
        AccountsService,
      ],
      useFactory: (
        db: OptionalDatabase,
        config: ApiConfig,
        valkey: ValkeyClient,
        activities: ActivitiesService,
        attendance: AttendanceService,
        authorization: AuthorizationService,
        people: PeopleService,
        presenter: PersonPresenter,
        entitlements: EntitlementsService,
        clubs: ClubsService,
        groups: GroupsService,
        accounts: AccountsService,
      ) =>
        new CalendarService(
          requireDatabase(db),
          {
            activities,
            attendance,
            authorization,
            people,
            presenter,
            entitlements,
            clubs,
            groups,
            accounts,
            limiter: new RateLimiter(valkey, config.RATE_LIMIT_NAMESPACE),
            cache:
              config.CALENDAR_FEED_CACHE_SECONDS > 0
                ? valkeyCache(valkey, config.RATE_LIMIT_NAMESPACE)
                : null,
          },
          {
            tokenKey: config.CALENDAR_TOKEN_KEY,
            webUrl: config.PUBLIC_WEB_URL,
            version: config.APP_VERSION,
            cacheSeconds: config.CALENDAR_FEED_CACHE_SECONDS,
          },
        ),
    },
  ],
  exports: [CalendarService],
})
export class CalendarModule {}
