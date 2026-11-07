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
import { ConsentsService } from "../privacy/index.ts";
import { ProtectionService } from "../protection/index.ts";

@Controller("people")
export class PersonProfilesController {
  private readonly people: PeopleService;
  private readonly guardianships: GuardianshipsService;
  private readonly presenter: PersonProfilePresenter;
  private readonly consents: ConsentsService;
  private readonly protection: ProtectionService;

  constructor(
    people: PeopleService,
    guardianships: GuardianshipsService,
    presenter: PersonProfilePresenter,
    consents: ConsentsService,
    protection: ProtectionService,
  ) {
    this.people = people;
    this.guardianships = guardianships;
    this.presenter = presenter;
    this.consents = consents;
    this.protection = protection;
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

    let guardianships = (await this.guardianships.guardiansOf(context, resource.personId)).filter(
      (g) => g.status === "active",
    );
    // Others in the club see only the guardians who chose to show their
    // contact details to the ward's groups or the whole club (P1.8a).
    if (access === "member") {
      const consents =
        resource.clubId && !resource.inClub?.protected
          ? await this.consents.contactConsentsOf(
              tenantContext(authz, resource.clubId),
              guardianships.map((g) => g.guardianPersonId),
            )
          : new Map<string, Set<string>>();
      const sharesGroup = resource.groups.some(
        (g) =>
          authz.actor.isGroupMember(g.groupId) ||
          authz.actor.isGuardianOfGroupMember(g.groupId, "act_on_behalf"),
      );
      guardianships = guardianships.filter((g) => {
        const given = consents.get(g.guardianPersonId);
        return (
          given !== undefined &&
          (given.has("contacts_club") || (sharesGroup && given.has("contacts_group")))
        );
      });
    }
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

    // The profile view log (P1.12, ADR 0022): views of protected people, and
    // every view in a club that logs them all; the viewer is told.
    const isProtected = person.protectedIdentity || resource.inClub?.protected === true;
    const viewsLogged = await this.people.recordProfileView(context, resource.personId, {
      clubId: resource.clubId,
      surface: "profile",
      protected: isProtected,
    });
    const profile = await this.presenter.present(authz, access, resource, person, guardians);
    if (!profile) throw new ProblemError("not-found");
    const protection = await this.protection.state(authz, resource, person);
    return {
      ...profile,
      ...(protection ? { protection } : {}),
      ...(viewsLogged ? { viewsLogged: true } : {}),
    };
  }
}
