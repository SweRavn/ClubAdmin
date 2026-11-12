// SPDX-License-Identifier: AGPL-3.0-only
// Club invitations (ADR 0018, P1.1): managers and registrars create, list and
// revoke them; group owners do so for their own groups (P1.15 A4); anyone can
// look one up from its link or code; a logged-in person accepts. Each group
// row is checked here: the caller may add people to the group, and may give
// its role (no escalation, A2.1).

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
  type InvitationOptions,
  InvitationOptionsSchema,
  InvitationParamsSchema,
  type InvitationResponse,
  OkSchema,
  type PageQuery,
  PageQuerySchema,
  type PersonSummary,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  AuthorizationService,
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { GroupsService } from "../groups/index.ts";
import { PeopleService } from "../people/index.ts";
import { ClubRolesService, mayAssignGroupRole } from "../roles/index.ts";
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
    groups: invitation.groups,
    clubRoleId: invitation.clubRoleId,
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
  private readonly authorization: AuthorizationService;
  private readonly clubRoles: ClubRolesService;
  private readonly groups: GroupsService;

  constructor(
    invitations: InvitationsService,
    people: PeopleService,
    presenter: PersonPresenter,
    authorization: AuthorizationService,
    clubRoles: ClubRolesService,
    groups: GroupsService,
  ) {
    this.invitations = invitations;
    this.people = people;
    this.presenter = presenter;
    this.authorization = authorization;
    this.clubRoles = clubRoles;
    this.groups = groups;
  }

  /**
   * The invitation's group rows, checked and with their roles resolved
   * (P1.15 A4): every group must be the club's, and the caller must be
   * allowed to add people to it (club.invitations.manage, or
   * group.members.manage there, which owners have); a role other than the
   * participant role needs group.members.manage in the group, and every role
   * passes the no-escalation rule. The club role must be a club role.
   */
  private async plan(
    authz: RequestAuthorization,
    clubId: string,
    body: CreateInvitationInput,
  ): Promise<{
    groups: { groupId: string; roleId: string }[];
    clubRoleId: string | null;
    administrator: boolean;
  }> {
    const actor = authz.actor;
    const invitesToClub = actor.holds("club.invitations.manage", clubId);
    const rows = [...(body.groups ?? [])];
    if (body.groupId && !rows.some((r) => r.groupId === body.groupId)) {
      rows.push({ groupId: body.groupId });
    }
    // Group owners invite to their groups: at least one, and no club role.
    if (!invitesToClub && (rows.length === 0 || body.rolePreset || body.clubRoleId)) {
      throw new DomainError("not_allowed");
    }
    const needsRoles = rows.length > 0 || body.clubRoleId || body.rolePreset;
    const roles = needsRoles ? await this.clubRoles.rolesOfClub(tenantContext(authz, clubId)) : [];
    const participant = roles.find((r) => r.scope === "group" && r.templateKey === "member");
    const resources = await this.authorization.groupResourcesOf(
      authz.context,
      rows.map((r) => r.groupId),
    );
    const groups = rows.map((row) => {
      const group = resources.get(row.groupId);
      if (!group || group.clubId !== clubId) throw new DomainError("not_found");
      const role = row.roleId ? roles.find((r) => r.id === row.roleId) : participant;
      if (!role || role.scope !== "group") throw new DomainError("not_found");
      const managesMembers = permits(actor, "group.members.manage", group);
      if (!invitesToClub && !managesMembers) throw new DomainError("not_allowed");
      if (role.id !== participant?.id && !managesMembers) {
        throw new DomainError("group_role_not_allowed");
      }
      if (!mayAssignGroupRole(actor, group, role.permissions)) {
        throw new DomainError("group_role_not_allowed");
      }
      return { groupId: row.groupId, roleId: role.id };
    });
    const clubRole = body.clubRoleId
      ? roles.find((r) => r.id === body.clubRoleId)
      : body.rolePreset
        ? roles.find((r) => r.scope === "club" && r.templateKey === body.rolePreset)
        : undefined;
    if (body.clubRoleId && clubRole?.scope !== "club") throw new DomainError("not_found");
    return {
      groups,
      clubRoleId: clubRole?.id ?? null,
      administrator:
        body.rolePreset === "club_manager" ||
        (clubRole?.permissions.includes("club.roles.manage") ?? false),
    };
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
    // Group owners see the invitations they made (P1.15 A4).
    const page = await this.invitations.list(context, query, {
      ownOnly: !authz.actor.holds("club.invitations.manage", clubId),
    });
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
    method: "GET",
    path: "clubs/:clubId/invitation-options",
    summary:
      "The groups I may invite to, with the roles I may give in each, and the club roles I may give",
    tags: ["joining"],
    access: { permission: "club.invitations.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: InvitationOptionsSchema,
  })
  async options(@CurrentAuthorization() authz: RequestAuthorization): Promise<InvitationOptions> {
    const { clubId } = resourceOf(authz, "club");
    const actor = authz.actor;
    const context = tenantContext(authz, clubId);
    const invitesToClub = actor.holds("club.invitations.manage", clubId);
    const groups = await this.groups.activeGroups(context);
    const roles = await this.clubRoles.rolesOfClub(context);
    const resources = await this.authorization.groupResourcesOf(
      authz.context,
      groups.map((g) => g.id),
    );
    const groupRoles = roles.filter((r) => r.scope === "group");
    const participant = groupRoles.find((r) => r.templateKey === "member");
    const view = (r: (typeof roles)[number]) => ({
      id: r.id,
      templateKey: r.templateKey,
      names: r.names,
    });
    const rows = groups.flatMap((g) => {
      const group = resources.get(g.id);
      if (!group) return [];
      const managesMembers = permits(actor, "group.members.manage", group);
      if (!invitesToClub && !managesMembers) return [];
      const roleIds = managesMembers
        ? groupRoles
            .filter(
              (r) => r.id === participant?.id || mayAssignGroupRole(actor, group, r.permissions),
            )
            .map((r) => r.id)
        : participant
          ? [participant.id]
          : [];
      // The participant role first, then the others in the club's order.
      roleIds.sort((a, b) => Number(b === participant?.id) - Number(a === participant?.id));
      const own = actor.ownsGroup(group) || actor.isGroupMember(g.id);
      return [{ id: g.id, name: g.name, kind: g.kind, own, roleIds }];
    });
    rows.sort((a, b) => Number(b.own) - Number(a.own));
    return {
      groups: rows,
      groupRoles: groupRoles.map(view),
      participantRoleId: participant?.id ?? null,
      clubRoles: actor.holds("club.roles.manage", clubId)
        ? roles.filter((r) => r.scope === "club").map(view)
        : [],
      clubWide: invitesToClub,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/invitations",
    summary:
      "Invite by email, or create a link or code (shown once), to groups with roles; club roles only for club managers",
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
    const plan = await this.plan(authz, clubId, body);
    // A club role grants a role: the same rule as assigning it (club manager with MFA).
    const created = await this.invitations.create(tenantContext(authz, clubId), body, {
      mayPresetRole: authz.actor.holds("club.roles.manage", clubId),
      mfa: authz.actor.mfa,
      ...plan,
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
    await this.invitations.revoke(tenantContext(authz, clubId), invitationId, {
      ownOnly: !authz.actor.holds("club.invitations.manage", clubId),
    });
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
