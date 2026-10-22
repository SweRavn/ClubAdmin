// SPDX-License-Identifier: AGPL-3.0-only
// Families (P1.3), the family's side: adding children, inviting and linking
// co-guardians, relatives and contact persons, the invitation link, a
// person's own relatives and contact persons, duplicates and the adult
// decision. A guardian acting for a ward (X-On-Behalf-Of) cannot change
// anything here: every write acts as the logged-in person.

import {
  type AcceptGuardianInvitationSchema,
  AcceptGuardianInvitationSchema as AcceptSchema,
  type AddChildInput,
  AddChildSchema,
  type AddLinkedPersonInput,
  AddLinkedPersonSchema,
  type AdultDecisionInput,
  AdultDecisionSchema,
  type AdultGuardians,
  AdultGuardiansSchema,
  type ChildAdded,
  ChildAddedSchema,
  type CreateGuardianInvitationInput,
  CreateGuardianInvitationSchema,
  type CreateTrustedPersonInput,
  CreateTrustedPersonSchema,
  type FamilyDuplicates,
  FamilyDuplicatesSchema,
  type GuardianInvitationAccepted,
  GuardianInvitationAcceptedSchema,
  type GuardianInvitationCreated,
  GuardianInvitationCreatedSchema,
  type GuardianInvitationLookup,
  GuardianInvitationLookupQuerySchema,
  GuardianInvitationLookupSchema,
  GuardianInvitationParamsSchema,
  type GuardianshipCreated,
  GuardianshipCreatedSchema,
  GuardianshipParamsSchema,
  type GuardianshipResult,
  GuardianshipResultSchema,
  OkSchema,
  PersonParamsSchema,
  type TrustedPeople,
  TrustedPeopleSchema,
  type TrustedPersonCreated,
  TrustedPersonCreatedSchema,
  type UpdateGuardianshipInput,
  UpdateGuardianshipSchema,
  type WardGuardians,
  WardGuardiansSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  FamilyPresenter,
  type GuardianPerson,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
} from "../authorization/index.ts";
import {
  type Guardianship,
  GuardianshipsService,
  type WardViewer,
} from "../guardianships/index.ts";
import { PeopleService } from "../people/index.ts";
import { PersonMergeService } from "../person-merge/index.ts";

/** Writes act as the logged-in person, never on behalf of a ward. */
export function asSelf(authz: RequestAuthorization): RequestAuthorization["context"] {
  if (authz.actor.onBehalfOf !== null) {
    throw new ProblemError("forbidden", { detail: "not_on_behalf" });
  }
  return authz.context;
}

const created = (invitation: { invitationId: string; expiresAt: Date }) => ({
  invitationId: invitation.invitationId,
  expiresAt: invitation.expiresAt.toISOString(),
});

const result = (g: Guardianship): GuardianshipResult => ({
  guardianshipId: g.id,
  kind: g.kind,
  rights: g.rights,
  status: g.status,
});

@Controller()
export class FamilyController {
  private readonly guardianships: GuardianshipsService;
  private readonly people: PeopleService;
  private readonly merges: PersonMergeService;
  private readonly presenter: PersonPresenter;
  private readonly family: FamilyPresenter;

  constructor(
    guardianships: GuardianshipsService,
    people: PeopleService,
    merges: PersonMergeService,
    presenter: PersonPresenter,
    family: FamilyPresenter,
  ) {
    this.guardianships = guardianships;
    this.people = people;
    this.merges = merges;
    this.presenter = presenter;
    this.family = family;
  }

  @Endpoint({
    method: "POST",
    path: "me/wards",
    summary: "Add a child without email; the caller becomes their parent (or legal guardian)",
    tags: ["families"],
    access: { authenticated: true },
    request: { body: AddChildSchema },
    response: ChildAddedSchema,
  })
  async addChild(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AddChildInput,
  ): Promise<ChildAdded> {
    const { kind, ...child } = AddChildSchema.parse(body);
    const added = await this.guardianships.addChild(asSelf(authz), child, kind);
    return {
      person: this.presenter.presentSelf(added.child),
      guardianshipId: added.guardianship.id,
    };
  }

  @Endpoint({
    method: "GET",
    path: "me/wards/:personId/guardians",
    summary:
      "A ward's guardians, relatives and contact persons, and pending invitations (relatives see names only)",
    tags: ["families"],
    access: { permission: "person.guardians.read", resource: "person" },
    request: { params: PersonParamsSchema },
    response: WardGuardiansSchema,
  })
  async wardGuardians(@CurrentAuthorization() authz: RequestAuthorization): Promise<WardGuardians> {
    const { personId } = resourceOf(authz, "person");
    const data = await this.guardianships.wardGuardians(authz.context, personId);
    const [ward] = await this.people.summaries(authz.context, [personId]);
    const shownWard = ward ? await this.presenter.presentOne(authz, null, ward) : null;
    if (!shownWard) throw new ProblemError("not-found");
    return {
      ward: shownWard,
      guardians: await this.presentGuardians(authz, data.guardianships, data.viewer),
      invitations: this.family.invitations(data.invitations, this.viewerOf(authz, data.viewer)),
    };
  }

  @Endpoint({
    method: "POST",
    path: "me/wards/:personId/guardian-invitations",
    summary:
      "Invite a co-guardian, relative or contact person by email (rights for the latter two)",
    tags: ["families"],
    access: { permission: "person.guardians.manage", resource: "person" },
    request: { params: PersonParamsSchema, body: CreateGuardianInvitationSchema },
    response: GuardianInvitationCreatedSchema,
    accountLimit: "joining",
  })
  async invite(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateGuardianInvitationInput,
  ): Promise<GuardianInvitationCreated> {
    const { personId } = resourceOf(authz, "person");
    return created(
      await this.guardianships.inviteCoGuardian(asSelf(authz), {
        wardPersonId: personId,
        email: body.email,
        kind: body.kind,
        rights: body.rights,
      }),
    );
  }

  @Endpoint({
    method: "POST",
    path: "me/wards/:personId/guardians",
    summary: "Link a relative or contact person without login (name and phone) to a ward",
    tags: ["families"],
    access: { permission: "person.guardians.manage", resource: "person" },
    request: { params: PersonParamsSchema, body: AddLinkedPersonSchema },
    response: GuardianshipCreatedSchema,
  })
  async addLinked(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AddLinkedPersonInput,
  ): Promise<GuardianshipCreated> {
    const { personId } = resourceOf(authz, "person");
    return this.linkWithoutLogin(authz, personId, body);
  }

  @Endpoint({
    method: "POST",
    path: "guardian-invitations/:invitationId/resend",
    summary: "Send an invitation again with a new link (the old link stops working)",
    tags: ["families"],
    access: { permission: "person.guardians.manage", resource: "person" },
    request: { params: GuardianInvitationParamsSchema },
    response: GuardianInvitationCreatedSchema,
    status: 200,
    accountLimit: "joining",
  })
  async resend(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("invitationId") invitationId: string,
  ): Promise<GuardianInvitationCreated> {
    const invitation = await this.guardianships.resendInvitation(asSelf(authz), invitationId);
    return { invitationId, expiresAt: invitation.expiresAt.toISOString() };
  }

  @Endpoint({
    method: "POST",
    path: "guardian-invitations/:invitationId/revoke",
    summary: "Revoke an invitation (its link stops working)",
    tags: ["families"],
    access: { permission: "person.guardians.manage", resource: "person" },
    request: { params: GuardianInvitationParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async revoke(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("invitationId") invitationId: string,
  ): Promise<{ ok: true }> {
    await this.guardianships.revokeInvitation(asSelf(authz), invitationId);
    return { ok: true };
  }

  @Endpoint({
    method: "GET",
    path: "guardian-invitations/lookup",
    summary:
      "What an invitation link is for (unknown, expired, revoked and used links are not found)",
    tags: ["families"],
    access: { public: true },
    request: { query: GuardianInvitationLookupQuerySchema },
    response: GuardianInvitationLookupSchema,
    // Guessing tokens: a tight per-IP limit (no login here).
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  })
  async lookup(@Query() query: { token: string }): Promise<GuardianInvitationLookup> {
    const invitation = await this.guardianships.lookupInvitation(query.token);
    if (!invitation) throw new ProblemError("not-found");
    const people = await this.people.invitationPeople([
      invitation.wardPersonId,
      invitation.invitedByPersonId,
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    return {
      kind: invitation.kind,
      rights: invitation.rights,
      ...this.family.invitationLanding(
        byId.get(invitation.wardPersonId) ?? null,
        byId.get(invitation.invitedByPersonId) ?? null,
      ),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  @Endpoint({
    method: "POST",
    path: "guardian-invitations/accept",
    summary:
      "Accept an invitation with the token from its link; the login email must be the invited address",
    tags: ["families"],
    access: { authenticated: true },
    request: { body: AcceptSchema },
    response: GuardianInvitationAcceptedSchema,
    status: 200,
    accountLimit: "joining",
  })
  async accept(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: z.infer<typeof AcceptGuardianInvitationSchema>,
  ): Promise<GuardianInvitationAccepted> {
    const guardianship = await this.guardianships.acceptInvitation(asSelf(authz), body.token);
    const [ward] = await this.people.summaries(authz.context, [guardianship.wardPersonId]);
    if (!ward) throw new ProblemError("not-found");
    return {
      guardianshipId: guardianship.id,
      ward: this.presenter.presentSelf(ward),
      kind: guardianship.kind,
      suggestProtection: ward.protectedIdentity,
    };
  }

  @Endpoint({
    method: "GET",
    path: "me/trusted-people",
    summary: "The relatives and contact persons linked to me, with their rights",
    tags: ["families"],
    access: { authenticated: true },
    response: TrustedPeopleSchema,
  })
  async trustedPeople(@CurrentAuthorization() authz: RequestAuthorization): Promise<TrustedPeople> {
    const data = await this.guardianships.trustedPeople(asSelf(authz));
    return {
      canLink: data.viewer.wardMayLink,
      people: await this.presentGuardians(authz, data.guardianships, data.viewer),
      invitations: this.family.invitations(data.invitations, this.viewerOf(authz, data.viewer)),
    };
  }

  @Endpoint({
    method: "POST",
    path: "me/trusted-people",
    summary:
      "Link a relative or contact person to myself (adult, or from the consent age): by email or without login",
    tags: ["families"],
    access: { authenticated: true },
    request: { body: CreateTrustedPersonSchema },
    response: TrustedPersonCreatedSchema,
    accountLimit: "joining",
  })
  async linkTrustedPerson(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateTrustedPersonInput,
  ): Promise<TrustedPersonCreated> {
    const context = asSelf(authz);
    const me = authz.principal.personId;
    const input = CreateTrustedPersonSchema.parse(body);
    if ("email" in input) {
      const invitation = await this.guardianships.inviteCoGuardian(context, {
        wardPersonId: me,
        email: input.email,
        kind: input.kind,
        rights: input.rights,
      });
      return { invitation: created(invitation), guardianship: null };
    }
    return { invitation: null, guardianship: await this.linkWithoutLogin(authz, me, input) };
  }

  @Endpoint({
    method: "PATCH",
    path: "guardianships/:guardianshipId",
    summary:
      "Change what a relative or contact person may do (a full guardian, or the adult ward for their own links)",
    tags: ["families"],
    access: { permission: "person.guardians.manage", resource: "person" },
    request: { params: GuardianshipParamsSchema, body: UpdateGuardianshipSchema },
    response: GuardianshipResultSchema,
  })
  async updateRights(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("guardianshipId") guardianshipId: string,
    @Body() body: UpdateGuardianshipInput,
  ): Promise<GuardianshipResult> {
    return result(
      await this.guardianships.updateRights(asSelf(authz), guardianshipId, body.rights),
    );
  }

  @Endpoint({
    method: "POST",
    path: "guardianships/:guardianshipId/end",
    summary:
      "End a guardianship: my own, or a relative's or contact person's (a full guardian, or the ward)",
    tags: ["families"],
    access: { authenticated: true },
    request: { params: GuardianshipParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async end(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("guardianshipId") guardianshipId: string,
  ): Promise<{ ok: true }> {
    await this.guardianships.endGuardianship(asSelf(authz), guardianshipId);
    return { ok: true };
  }

  @Endpoint({
    method: "GET",
    path: "me/duplicates",
    summary:
      "Pairs among my wards and my co-guardians' wards that look like the same person, and my undoable merges",
    tags: ["families"],
    access: { authenticated: true },
    response: FamilyDuplicatesSchema,
  })
  async duplicates(@CurrentAuthorization() authz: RequestAuthorization): Promise<FamilyDuplicates> {
    const data = await this.merges.familyDuplicates(asSelf(authz));
    const details = new Map(data.details.map((d) => [d.id, d]));
    const guardianIds = [...new Set(data.details.flatMap((d) => d.guardianIds))];
    const keptIds = data.merges.map((m) => m.keptPersonId);
    const [guardians, kept] = await Promise.all([
      this.people.summaries(authz.context, guardianIds),
      this.people.summaries(authz.context, keptIds),
    ]);
    // Pair people come with their global flags; anyone the guardian may not see is left out.
    const shown = await this.family.byId(authz, [...data.people, ...guardians, ...kept]);
    const people = new Map(data.people.map((p) => [p.id, p]));
    const side = (id: string) => {
      const person = shown.get(id);
      if (!person) return null;
      const d = details.get(id);
      return {
        person,
        birthDate: people.get(id)?.birthDate ?? null,
        clubs: d?.clubs ?? [],
        guardians: (d?.guardianIds ?? []).flatMap((g) => {
          const s = shown.get(g);
          return s ? [s] : [];
        }),
      };
    };
    const { actor } = authz;
    return {
      pairs: data.candidates.flatMap((c) => {
        const a = side(c.personId);
        const b = side(c.duplicatePersonId);
        if (!a || !b) return [];
        return [
          {
            person: a,
            duplicate: b,
            reason: c.reason,
            canMerge:
              actor.isFullGuardianOf(c.personId) && actor.isFullGuardianOf(c.duplicatePersonId),
          },
        ];
      }),
      merges: data.merges.flatMap((m) => {
        const person = shown.get(m.keptPersonId);
        return person
          ? [{ mergeId: m.id, kept: person, undoUntil: m.undoUntil.toISOString() }]
          : [];
      }),
    };
  }

  @Endpoint({
    method: "GET",
    path: "me/adult-guardians",
    summary: "My guardians flagged at the adult age, with my decision for each",
    tags: ["families"],
    access: { authenticated: true },
    response: AdultGuardiansSchema,
  })
  async adultGuardians(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<AdultGuardians> {
    const rows = await this.guardianships.adultGuardians(asSelf(authz));
    const people = await this.people.summaries(
      authz.context,
      rows.map((r) => r.guardianPersonId),
    );
    const shown = await this.family.byId(authz, people);
    return {
      guardians: rows.flatMap((r) => {
        const person = shown.get(r.guardianPersonId);
        return person && r.wardAdultFlaggedAt
          ? [
              {
                guardianshipId: r.id,
                person,
                kind: r.kind,
                flaggedAt: r.wardAdultFlaggedAt.toISOString(),
                decision: r.adultDecision,
              },
            ]
          : [];
      }),
    };
  }

  @Endpoint({
    method: "POST",
    path: "me/adult-guardians/:guardianshipId/decision",
    summary: "Keep or end a guardian's access at the adult age (only the young person, once)",
    tags: ["families"],
    access: { authenticated: true },
    request: { params: GuardianshipParamsSchema, body: AdultDecisionSchema },
    response: GuardianshipResultSchema,
    status: 200,
  })
  async decide(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("guardianshipId") guardianshipId: string,
    @Body() body: AdultDecisionInput,
  ): Promise<GuardianshipResult> {
    return result(
      await this.guardianships.decideAdult(asSelf(authz), guardianshipId, body.decision),
    );
  }

  private async linkWithoutLogin(
    authz: RequestAuthorization,
    wardPersonId: string,
    body: AddLinkedPersonInput,
  ): Promise<GuardianshipCreated> {
    const linked = await this.guardianships.addLinkedPerson(asSelf(authz), {
      wardPersonId,
      person: body.person,
      kind: body.kind,
      rights: body.rights,
    });
    // The caller created the person, so they may see them.
    return {
      guardianshipId: linked.guardianship.id,
      person: this.presenter.presentSelf(linked.person),
    };
  }

  private viewerOf(authz: RequestAuthorization, viewer: WardViewer) {
    return { personId: authz.principal.personId, ...viewer };
  }

  private async presentGuardians(
    authz: RequestAuthorization,
    rows: readonly Guardianship[],
    viewer: WardViewer,
  ) {
    const people = await this.people.getPeople(
      authz.context,
      rows.map((r) => r.guardianPersonId),
    );
    const byId = new Map<string, GuardianPerson>(people.map((p) => [p.id, p]));
    return this.family.guardians(authz, null, rows, byId, this.viewerOf(authz, viewer));
  }
}
