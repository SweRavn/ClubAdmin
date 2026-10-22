// SPDX-License-Identifier: AGPL-3.0-only
// Club invitations (ADR 0018, P1.1): managers and registrars create, list and
// revoke them; anyone can look one up from its link or code; a logged-in
// person accepts.

import {
  type AcceptInvitationInput,
  AcceptInvitationSchema,
  ClubParamsSchema,
  type CreateInvitationInput,
  CreateInvitationSchema,
  type InvitationAccepted,
  InvitationAcceptedSchema,
  type InvitationCreated,
  InvitationCreatedSchema,
  type InvitationList,
  InvitationListSchema,
  type InvitationLookup,
  InvitationLookupQuerySchema,
  InvitationLookupSchema,
  InvitationParamsSchema,
  type InvitationResponse,
  OkSchema,
  type PageQuery,
  PageQuerySchema,
  type PersonSummary,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import {
  type Invitation,
  type InvitationSecret,
  InvitationsService,
  invitationState,
} from "./invitations.service.ts";

const secretOf = (input: {
  token?: string | undefined;
  code?: string | undefined;
}): InvitationSecret =>
  input.token !== undefined ? { token: input.token } : { code: input.code ?? "" };

function toResponse(invitation: Invitation, createdBy: PersonSummary | null): InvitationResponse {
  return {
    id: invitation.id,
    kind: invitation.kind,
    state: invitationState(invitation),
    email: invitation.email,
    groupId: invitation.groupId,
    rolePreset: invitation.rolePreset,
    expiresAt: invitation.expiresAt.toISOString(),
    maxUses: invitation.maxUses,
    uses: invitation.uses,
    createdAt: invitation.createdAt.toISOString(),
    createdBy,
  };
}

@Controller()
export class InvitationsController {
  private readonly invitations: InvitationsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(invitations: InvitationsService, people: PeopleService, presenter: PersonPresenter) {
    this.invitations = invitations;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/invitations",
    summary: "The club's invitations, newest first (secrets are never returned after creation)",
    tags: ["joining"],
    access: { permission: "club.invitations.manage", resource: "club" },
    request: { params: ClubParamsSchema, query: PageQuerySchema },
    response: InvitationListSchema,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<InvitationList> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const page = await this.invitations.list(context, query);
    const creators = [...new Set(page.items.map((i) => i.createdByPersonId))];
    const rows = await this.people.summaries(context, creators);
    const shown = new Map(
      (await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]),
    );
    return {
      items: page.items.map((i) => toResponse(i, shown.get(i.createdByPersonId) ?? null)),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/invitations",
    summary:
      "Invite by email, or create a link or code (shown once); role presets only for club managers",
    tags: ["joining"],
    access: { permission: "club.invitations.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateInvitationSchema },
    response: InvitationCreatedSchema,
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateInvitationInput,
  ): Promise<InvitationCreated> {
    const { clubId } = resourceOf(authz, "club");
    // A role preset grants a role: the same rule as assigning it (club.roles.manage).
    const mayPresetRole = authz.actor.isClubManager(clubId) && authz.actor.mfa;
    const created = await this.invitations.create(tenantContext(authz, clubId), body, {
      mayPresetRole,
    });
    return {
      invitation: toResponse(created.invitation, null),
      url: created.url,
      code: created.code,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/invitations/:invitationId/revoke",
    summary: "Revoke an invitation (links and codes stop working at once)",
    tags: ["joining"],
    access: { permission: "club.invitations.manage", resource: "club" },
    request: { params: InvitationParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async revoke(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("invitationId") invitationId: string,
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.invitations.revoke(tenantContext(authz, clubId), invitationId);
    return { ok: true };
  }

  @Endpoint({
    method: "GET",
    path: "invitations/lookup",
    summary:
      "Which club an invitation link or code is for (expired, revoked and used-up ones are not found)",
    tags: ["joining"],
    access: { public: true },
    request: { query: InvitationLookupQuerySchema },
    response: InvitationLookupSchema,
    // Guessing codes: a tight per-IP limit (no login here).
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  })
  lookup(@Query() query: { token?: string; code?: string }): Promise<InvitationLookup> {
    return this.invitations.lookup(secretOf(query));
  }

  @Endpoint({
    method: "POST",
    path: "invitations/accept",
    summary: "Accept an invitation: become an active member, with the invitation's presets",
    tags: ["joining"],
    access: { authenticated: true },
    request: { body: AcceptInvitationSchema },
    response: InvitationAcceptedSchema,
    status: 200,
    accountLimit: "joining",
  })
  accept(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: AcceptInvitationInput,
  ): Promise<InvitationAccepted> {
    return this.invitations.accept(authz.context, secretOf(body));
  }
}
