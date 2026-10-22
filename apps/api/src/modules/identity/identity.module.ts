// SPDX-License-Identifier: AGPL-3.0-only
import { DEV_AUTH_MOBILE_CLIENT } from "@clubadmin/shared";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { RateLimiter } from "../../platform/http/rate-limiter.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import {
  AuthorizationModule,
  AuthorizationService,
  PersonPresenter,
} from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { GroupsModule } from "../groups/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { RolesModule, RolesService } from "../roles/index.ts";
import { AuthGuard } from "./auth.guard.ts";
import { DevController } from "./dev.controller.ts";
import { DevPersonasService } from "./dev-personas.service.ts";
import { IdentityService } from "./identity.service.ts";
import { MeController } from "./me.controller.ts";
import { RequestLimits } from "./request-limits.ts";
import { SessionsService, zitadelSessions } from "./sessions.service.ts";
import { TokenVerifier } from "./token-verifier.ts";

@Module({})
export class IdentityModule {
  /** The dev controller (persona list) exists only when DEV_AUTH is on. */
  static register(config: Pick<ApiConfig, "DEV_AUTH">): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        AccountsModule,
        AuthorizationModule,
        PeopleModule,
        ClubsModule,
        GroupsModule,
        MembershipsModule,
        RolesModule,
      ],
      controllers: config.DEV_AUTH ? [MeController, DevController] : [MeController],
      providers: [
        {
          provide: TokenVerifier,
          inject: [API_CONFIG],
          useFactory: (c: ApiConfig) =>
            new TokenVerifier({
              issuer: c.AUTH_ISSUER,
              audience: c.AUTH_AUDIENCE,
              jwksUrl: c.AUTH_JWKS_URL,
              devAuthKey: c.DEV_AUTH ? c.DEV_AUTH_KEY : undefined,
            }),
        },
        {
          provide: RequestLimits,
          inject: [API_CONFIG, VALKEY_CLIENT],
          useFactory: (c: ApiConfig, valkey: ValkeyClient) =>
            new RequestLimits(new RateLimiter(valkey), c),
        },
        {
          provide: IdentityService,
          inject: [AccountsService, RequestLimits],
          useFactory: (accounts: AccountsService, limits: RequestLimits) =>
            new IdentityService(accounts, limits),
        },
        {
          provide: SessionsService,
          inject: [API_CONFIG, DATABASE, VALKEY_CLIENT],
          useFactory: (c: ApiConfig, db: OptionalDatabase, valkey: ValkeyClient) => {
            const zitadelUrl = c.ZITADEL_API_URL ?? c.AUTH_ISSUER;
            return new SessionsService(
              requireDatabase(db),
              valkey,
              zitadelUrl && c.ZITADEL_API_TOKEN
                ? zitadelSessions(zitadelUrl, c.ZITADEL_API_TOKEN)
                : undefined,
            );
          },
        },
        {
          provide: DevPersonasService,
          inject: [
            AccountsService,
            PeopleService,
            ClubsService,
            MembershipsService,
            RolesService,
            PersonPresenter,
          ],
          useFactory: (
            accounts: AccountsService,
            people: PeopleService,
            clubs: ClubsService,
            memberships: MembershipsService,
            roles: RolesService,
            presenter: PersonPresenter,
          ) => new DevPersonasService({ accounts, people, clubs, memberships, roles, presenter }),
        },
        {
          provide: APP_GUARD,
          inject: [
            API_CONFIG,
            Reflector,
            TokenVerifier,
            IdentityService,
            AuthorizationService,
            RequestLimits,
            SessionsService,
          ],
          useFactory: (
            c: ApiConfig,
            reflector: Reflector,
            verifier: TokenVerifier,
            identity: IdentityService,
            authorization: AuthorizationService,
            limits: RequestLimits,
            sessions: SessionsService,
          ) =>
            new AuthGuard(
              reflector,
              verifier,
              identity,
              authorization,
              limits,
              sessions,
              new Set(
                [c.AUTH_MOBILE_CLIENT_ID, c.DEV_AUTH ? DEV_AUTH_MOBILE_CLIENT : undefined].filter(
                  (id): id is string => Boolean(id),
                ),
              ),
            ),
        },
      ],
      exports: [IdentityService, TokenVerifier],
    };
  }
}
