// SPDX-License-Identifier: AGPL-3.0-only
// Registered only when DEV_AUTH=true (IdentityModule); the API refuses to
// start with DEV_AUTH outside development.

import { type PersonaList, PersonaListSchema } from "@clubadmin/shared";
import { Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { DevPersonasService } from "./dev-personas.service.ts";

@Controller("dev")
export class DevController {
  private readonly personas: DevPersonasService;

  constructor(personas: DevPersonasService) {
    this.personas = personas;
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
}
