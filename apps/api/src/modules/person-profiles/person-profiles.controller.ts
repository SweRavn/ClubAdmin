// SPDX-License-Identifier: AGPL-3.0-only
import {
  PersonParamsSchema,
  type PersonProfile,
  PersonProfileSchema,
  PersonQuerySchema,
} from "@clubadmin/shared";
import { Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  PersonProfilePresenter,
  profileAccess,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { GuardianshipsService } from "../guardianships/index.ts";
import { PeopleService } from "../people/index.ts";

@Controller("people")
export class PersonProfilesController {
  private readonly people: PeopleService;
  private readonly guardianships: GuardianshipsService;
  private readonly presenter: PersonProfilePresenter;

  constructor(
    people: PeopleService,
    guardianships: GuardianshipsService,
    presenter: PersonProfilePresenter,
  ) {
    this.people = people;
    this.guardianships = guardianships;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: ":personId",
    summary: "A person as the caller may see them in a club (fields depend on the relationship)",
    tags: ["people"],
    access: { permission: "person.profile.read", resource: "person" },
    request: { params: PersonParamsSchema, query: PersonQuerySchema },
    response: PersonProfileSchema,
  })
  async getProfile(@CurrentAuthorization() authz: RequestAuthorization): Promise<PersonProfile> {
    const resource = resourceOf(authz, "person");
    const access = profileAccess(authz.actor, resource);
    if (!access) throw new ProblemError("not-found");
    const context = resource.clubId ? tenantContext(authz, resource.clubId) : authz.context;
    const person = await this.people.getPerson(context, resource.personId);

    const guardianships =
      access === "member"
        ? []
        : (await this.guardianships.guardiansOf(context, resource.personId)).filter(
            (g) => g.status === "active",
          );
    const guardianPeople = new Map(
      (
        await this.people.getPeople(
          context,
          guardianships.map((g) => g.guardianPersonId),
        )
      ).map((p) => [p.id, p]),
    );
    const guardians = guardianships.flatMap((g) => {
      const p = guardianPeople.get(g.guardianPersonId);
      return p ? [{ kind: g.kind, person: p }] : [];
    });

    // Access log (ADR 0022): every view of a protected person by someone else.
    const isProtected = person.protectedIdentity || resource.inClub?.protected === true;
    if (isProtected && !authz.actor.isSelf(resource.personId)) {
      await this.people.recordProtectedView(context, resource.personId);
    }
    const profile = await this.presenter.present(authz, access, resource, person, guardians);
    if (!profile) throw new ProblemError("not-found");
    return profile;
  }
}
