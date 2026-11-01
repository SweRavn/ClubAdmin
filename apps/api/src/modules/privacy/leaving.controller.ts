// SPDX-License-Identifier: AGPL-3.0-only
// Leaving a club yourself and stepping down from assignments (P1.8a). The
// person, or a full guardian for a ward (personId in the query or body);
// anyone else gets 404. A person's rights do not depend on the club's
// subscription: these work in read-only and suspended clubs too.

import {
  type Assignment,
  AssignmentParamsSchema,
  AssignmentsSchema,
  ClubParamsSchema,
  type LeaveClubInput,
  LeaveClubSchema,
  type LeavePreview,
  LeavePreviewSchema,
  PersonInClubQuerySchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { RecentAuth } from "../identity/index.ts";
import { LeavingService } from "./leaving.service.ts";

const EmptySchema = z.object({}).openapi("Empty");

/** The caller or a ward they are a full guardian of; 404 otherwise. */
function subjectOf(authz: RequestAuthorization, personId: string | undefined): string {
  const me = authz.actor.personId;
  const id = personId ?? me;
  if (id === me || authz.actor.isFullGuardianOf(id)) return id;
  throw new ProblemError("not-found");
}

@Controller("me/clubs")
export class LeavingController {
  private readonly leaving: LeavingService;

  constructor(leaving: LeavingService) {
    this.leaving = leaving;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/assignments",
    summary: "My (or my child's) club roles, leader functions and group ownerships in a club",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: ClubParamsSchema, query: PersonInClubQuerySchema },
    response: AssignmentsSchema,
  })
  async assignments(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ClubParamsSchema>,
    @Query() query: z.infer<typeof PersonInClubQuerySchema>,
  ): Promise<{ personId: string; clubId: string; items: Assignment[] }> {
    const personId = subjectOf(authz, query.personId);
    const items = await this.leaving.assignments(tenantContext(authz, params.clubId), personId);
    return { personId, clubId: params.clubId, items };
  }

  @Endpoint({
    method: "DELETE",
    path: ":clubId/assignments/:assignmentId",
    summary: "Step down from a club role, a leader function or a group ownership",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: AssignmentParamsSchema, query: PersonInClubQuerySchema },
    response: EmptySchema,
  })
  @RecentAuth(15)
  async stepDown(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof AssignmentParamsSchema>,
    @Query() query: z.infer<typeof PersonInClubQuerySchema>,
  ): Promise<Record<string, never>> {
    const personId = subjectOf(authz, query.personId);
    await this.leaving.stepDown(tenantContext(authz, params.clubId), personId, params.assignmentId);
    return {};
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/leave-preview",
    summary: "What leaving the club ends, what the club keeps, and what must be settled first",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: ClubParamsSchema, query: PersonInClubQuerySchema },
    response: LeavePreviewSchema,
  })
  async preview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ClubParamsSchema>,
    @Query() query: z.infer<typeof PersonInClubQuerySchema>,
  ): Promise<LeavePreview> {
    const personId = subjectOf(authz, query.personId);
    const preview = await this.leaving.preview(tenantContext(authz, params.clubId), personId);
    if (!preview.member) throw new ProblemError("not-found");
    return {
      personId,
      clubId: params.clubId,
      clubName: preview.clubName,
      blockers: preview.blockers,
      ends: [
        "membership",
        "groups",
        "join_requests",
        "waiting_lists",
        "event_registrations",
        "consents",
      ],
      keeps: { formerMemberRetentionMonths: preview.formerMemberRetentionMonths },
    };
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/leave",
    summary: "Leave the club (myself, or my child)",
    tags: ["privacy"],
    access: { authenticated: true },
    request: { params: ClubParamsSchema, body: LeaveClubSchema },
    response: EmptySchema,
  })
  @RecentAuth(15)
  async leave(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ClubParamsSchema>,
    @Body() body: LeaveClubInput,
  ): Promise<Record<string, never>> {
    const personId = subjectOf(authz, body.personId);
    // Adults leave themselves; a minor's full guardians leave for them.
    if (personId === authz.actor.personId && authz.actor.relationships.guardians.length > 0) {
      const minor = await this.leaving.isMinor(tenantContext(authz, params.clubId), personId);
      if (minor) throw new ProblemError("forbidden", { detail: "guardian_must_leave" });
    }
    await this.leaving.leave(tenantContext(authz, params.clubId), personId, {
      removeNow: body.removeNow ?? false,
    });
    return {};
  }
}
