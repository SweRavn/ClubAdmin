// SPDX-License-Identifier: AGPL-3.0-only
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AccountsModule, AccountsService } from "../accounts/index.ts";
import {
  AuthorizationModule,
  AuthorizationService,
  PersonPresenter,
} from "../authorization/index.ts";
import { ClubsModule, ClubsService } from "../clubs/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { RolesModule, RolesService } from "../roles/index.ts";
import { AuthGuard } from "./auth.guard.ts";
import { DevController } from "./dev.controller.ts";
import { DevPersonasService } from "./dev-personas.service.ts";
import { IdentityService } from "./identity.service.ts";
import { MeController } from "./me.controller.ts";
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
          provide: IdentityService,
          inject: [AccountsService],
          useFactory: (accounts: AccountsService) => new IdentityService(accounts),
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
          inject: [Reflector, TokenVerifier, IdentityService, AuthorizationService],
          useFactory: (
            reflector: Reflector,
            verifier: TokenVerifier,
            identity: IdentityService,
            authorization: AuthorizationService,
          ) => new AuthGuard(reflector, verifier, identity, authorization),
        },
      ],
      exports: [IdentityService, TokenVerifier],
    };
  }
}
