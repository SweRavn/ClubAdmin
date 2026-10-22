// SPDX-License-Identifier: AGPL-3.0-only
// Registered only when DEV_AUTH=true (IdentityModule); the API refuses to
// start with DEV_AUTH outside development.

import { DEV_TOKEN_SECONDS, mintDevToken } from "@clubadmin/server-kit/dev-tokens";
import {
  DEV_AUTH_MOBILE_CLIENT,
  type DevTokenRequest,
  DevTokenRequestSchema,
  type DevTokenResponse,
  DevTokenResponseSchema,
  type PersonaList,
  PersonaListSchema,
  uuidv7,
} from "@clubadmin/shared";
import { Body, Controller, Inject } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { DevPersonasService } from "./dev-personas.service.ts";

@Controller("dev")
export class DevController {
  private readonly personas: DevPersonasService;
  private readonly config: ApiConfig;

  constructor(personas: DevPersonasService, @Inject(API_CONFIG) config: ApiConfig) {
    this.personas = personas;
    this.config = config;
  }

  @Endpoint({
    method: "GET",
    path: "personas",
    summary: "People to log in as with DEV_AUTH (development only)",
    tags: ["development"],
    access: { public: true },
    response: PersonaListSchema,
    hidden: true,
  })
  list(): Promise<PersonaList> {
    return this.personas.list();
  }

  /**
   * Development tokens for the mobile app's persona picker. The web BFF mints
   * its own; the app must never hold DEV_AUTH_KEY. Each call is a new session.
   */
  @Endpoint({
    method: "POST",
    path: "tokens",
    summary: "Log in as a person with DEV_AUTH (development only, mobile app)",
    tags: ["development"],
    access: { public: true },
    request: { body: DevTokenRequestSchema },
    response: DevTokenResponseSchema,
    status: 200,
    hidden: true,
  })
  async tokens(@Body() body: DevTokenRequest): Promise<DevTokenResponse> {
    const sessionId = uuidv7();
    const accessToken = await mintDevToken(this.config.DEV_AUTH_KEY!, body.personId, {
      mfa: body.mfa,
      sessionId,
      clientId: DEV_AUTH_MOBILE_CLIENT,
    });
    return {
      accessToken,
      idToken: null,
      expiresAt: new Date(Date.now() + DEV_TOKEN_SECONDS * 1000).toISOString(),
      sessionId,
    };
  }
}
