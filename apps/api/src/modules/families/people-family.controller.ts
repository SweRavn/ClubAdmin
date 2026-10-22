// SPDX-License-Identifier: AGPL-3.0-only
// Families (P1.3) on a person: merging duplicates (a full guardian of both,
// or a club manager with a second factor for two members of the club,
// ?clubId=), undoing a merge within 30 days, and "Give own login".

import {
  MergeParamsSchema,
  type MergePeopleInput,
  MergePeopleSchema,
  type MergeResult,
  MergeResultSchema,
  OkSchema,
  OwnLoginInvitationCreatedSchema,
  OwnLoginInvitationSchema,
  PersonParamsSchema,
  PersonQuerySchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { AccountsService } from "../accounts/index.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PersonMergeService } from "../person-merge/index.ts";
import { asSelf } from "./family.controller.ts";

/** The club's context when the request names one (?clubId=), else the person's own. */
function contextOf(authz: RequestAuthorization) {
  const { clubId } = resourceOf(authz, "person");
  asSelf(authz);
  return clubId ? tenantContext(authz, clubId) : authz.context;
}

@Controller("people")
export class PeopleFamilyController {
  private readonly merges: PersonMergeService;
  private readonly accounts: AccountsService;

  constructor(merges: PersonMergeService, accounts: AccountsService) {
    this.merges = merges;
    this.accounts = accounts;
  }

  @Endpoint({
    method: "POST",
    path: ":personId/merge",
    summary: "Merge a duplicate into this person (never one with a login); undoable for 30 days",
    tags: ["families"],
    access: { permission: "person.merge", resource: "person" },
    request: { params: PersonParamsSchema, query: PersonQuerySchema, body: MergePeopleSchema },
    response: MergeResultSchema,
  })
  async merge(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: MergePeopleInput,
  ): Promise<MergeResult> {
    const { personId } = resourceOf(authz, "person");
    const merge = await this.merges.merge(contextOf(authz), personId, body.duplicatePersonId);
    return {
      mergeId: merge.id,
      keptPersonId: merge.keptPersonId,
      undoUntil: merge.undoUntil.toISOString(),
    };
  }

  @Endpoint({
    method: "POST",
    path: "merges/:mergeId/undo",
    summary: "Undo a merge within its period (refused when something changed since)",
    tags: ["families"],
    access: { permission: "person.merge", resource: "person" },
    request: { params: MergeParamsSchema, query: PersonQuerySchema },
    response: OkSchema,
    status: 200,
  })
  async undo(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("mergeId") mergeId: string,
  ): Promise<{ ok: true }> {
    await this.merges.undo(contextOf(authz), mergeId);
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: ":personId/own-login-invitations",
    summary:
      "Give own login: invite the person's own email (from the country pack's own-login age; not for people with a login)",
    tags: ["families"],
    access: { permission: "person.own_login.invite", resource: "person" },
    request: {
      params: PersonParamsSchema,
      query: PersonQuerySchema,
      body: OwnLoginInvitationSchema,
    },
    response: OwnLoginInvitationCreatedSchema,
    accountLimit: "joining",
  })
  async ownLogin(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: z.infer<typeof OwnLoginInvitationSchema>,
  ): Promise<z.infer<typeof OwnLoginInvitationCreatedSchema>> {
    const { personId } = resourceOf(authz, "person");
    const invitation = await this.accounts.createOwnLoginInvitation(
      contextOf(authz),
      personId,
      body.email,
    );
    return {
      invitationId: invitation.invitationId,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }
}
