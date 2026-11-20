// SPDX-License-Identifier: AGPL-3.0-only
import {
  ClubContactQuerySchema,
  OkSchema,
  PersonParamsSchema,
  type PersonProfile,
  PersonProfileSchema,
  PersonQuerySchema,
  type UpdateContactInput,
  UpdateContactSchema,
} from "@clubadmin/shared";
import { Body, Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import { AccountsService } from "../accounts/index.ts";
import {
  CurrentAuthorization,
  PersonProfilePresenter,
  type PersonResource,
  type ProfileAccess,
  profileAccess,
  type RequestAuthorization,
  resourceOf,
  seesClubContact,
  tenantContext,
} from "../authorization/index.ts";
import { GuardianshipsService } from "../guardianships/index.ts";
import { PeopleService } from "../people/index.ts";
import { ConsentsService } from "../privacy/index.ts";
import { ProtectionService } from "../protection/index.ts";

const WRITE_LIMIT = { max: 30, timeWindowMs: 60_000 };

@Controller("people")
export class PersonProfilesController {
  private readonly people: PeopleService;
  private readonly guardianships: GuardianshipsService;
  private readonly presenter: PersonProfilePresenter;
  private readonly consents: ConsentsService;
  private readonly protection: ProtectionService;
  private readonly accounts: AccountsService;

  constructor(
    people: PeopleService,
    guardianships: GuardianshipsService,
    presenter: PersonProfilePresenter,
    consents: ConsentsService,
    protection: ProtectionService,
    accounts: AccountsService,
  ) {
    this.accounts = accounts;
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
    // contact details to the ward's groups or the whole club (P1.8a); the
    // club's registrars see them all (P2.7d, ADR 0057).
    if (access === "member" && !seesClubContact(authz.actor, resource)) {
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
      ...(await this.withContact(authz, access, resource, profile)),
      ...(protection ? { protection } : {}),
      ...(viewsLogged ? { viewsLogged: true } : {}),
    };
  }

  /**
   * P2.7d (ADR 0057): the login emails (read-only) for the person, their
   * guardians acting for them and the club's registrars, who also see the
   * guardians' (a child without a login is reached through them); and who
   * may change the phone and address.
   */
  private async withContact(
    authz: RequestAuthorization,
    access: ProfileAccess,
    resource: PersonResource,
    profile: PersonProfile,
  ): Promise<PersonProfile> {
    const clubContact = seesClubContact(authz.actor, resource);
    if (access !== "self" && !clubContact) return profile;
    const guardianIds = clubContact ? (profile.guardians ?? []).map((g) => g.person.id) : [];
    const emails = await this.accounts.loginEmailsOf([resource.personId, ...guardianIds]);
    const editable =
      access === "self"
        ? ("self" as const)
        : authz.actor.onBehalfOf === null &&
            resource.clubId !== null &&
            authz.actor.holds("club.people.contact.edit", resource.clubId)
          ? ("club" as const)
          : undefined;
    return {
      ...profile,
      email: emails.get(resource.personId) ?? null,
      ...(clubContact && profile.guardians
        ? {
            guardians: profile.guardians.map((g) => ({
              ...g,
              email: emails.get(g.person.id) ?? null,
            })),
          }
        : {}),
      ...(editable ? { contactEditable: editable } : {}),
    };
  }

  @Endpoint({
    method: "PATCH",
    path: ":personId/contact",
    summary:
      "Change my own or my ward's phone and address (the person, or a guardian acting on their behalf)",
    tags: ["people"],
    access: { permission: "person.profile.update", resource: "person" },
    request: { params: PersonParamsSchema, body: UpdateContactSchema },
    response: OkSchema,
    rateLimit: WRITE_LIMIT,
  })
  async updateOwnContact(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: UpdateContactInput,
  ): Promise<{ ok: true }> {
    const resource = resourceOf(authz, "person");
    await this.people.updateContact(authz.context, resource.personId, body);
    return { ok: true };
  }

  @Endpoint({
    method: "PATCH",
    path: ":personId/club-contact",
    summary:
      "Change a member's phone and address for the club (club.people.contact.edit, second factor; never the login email)",
    tags: ["people"],
    access: { permission: "club.people.contact.edit", resource: "person" },
    request: {
      params: PersonParamsSchema,
      query: ClubContactQuerySchema,
      body: UpdateContactSchema,
    },
    response: OkSchema,
    rateLimit: WRITE_LIMIT,
  })
  async updateClubContact(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: UpdateContactInput,
  ): Promise<{ ok: true }> {
    const resource = resourceOf(authz, "person");
    await this.people.updateContact(
      tenantContext(authz, resource.clubId!),
      resource.personId,
      body,
    );
    return { ok: true };
  }
}
